import { runtimeConfig } from './runtime.js';

const streamError = (message, code, status) => Object.assign(new Error(message), {
  code,
  ...(status === undefined ? {} : { status }),
});

// A connection owns its parser; event IDs are remembered by openKdsStream instead.
export function createSseParser({ onEvent, onId } = {}) {
  let buffer = '';
  let skipLf = false;
  let firstChunk = true;
  let event = { name: 'message', data: [], id: null };
  const consumeLine = (line) => {
    if (!line) {
      const current = event;
      event = { name: 'message', data: [], id: null };
      if (current.data.length) onEvent?.({ ...current, data: current.data.join('\n') });
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event.name = value || 'message';
    if (field === 'data') event.data.push(value);
    if (field === 'id' && !value.includes('\0')) {
      event.id = value;
      onId?.(value);
    }
  };
  return {
    push(text) {
      if (!text) return;
      if (firstChunk) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        firstChunk = false;
      }
      if (skipLf) {
        if (text.startsWith('\n')) text = text.slice(1);
        skipLf = false;
      }
      buffer += text;
      while (buffer.length) {
        const boundary = buffer.search(/[\r\n]/);
        if (boundary === -1) break;
        const separator = buffer[boundary];
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (separator === '\r') {
          if (buffer.startsWith('\n')) buffer = buffer.slice(1);
          else if (!buffer.length) skipLf = true;
        }
        consumeLine(line);
      }
    },
  };
}

export function openKdsStream({
  token,
  storeId = 'store-default',
  baseUrl = runtimeConfig.apiBaseUrl,
  fetchImpl = globalThis.fetch,
  onOrder,
  onStatus,
  onAuthError,
  onError,
  retryMs = 3000,
  maxEventIds = 500,
  signal,
} = {}) {
  const controller = new AbortController();
  const seenIds = new Set();
  const idLimit = Number.isSafeInteger(maxEventIds) && maxEventIds > 0 ? maxEventIds : 500;
  let stopped = false;
  let retryTimer;
  let reader = null;
  let lastEventId = '';
  let status;
  const notify = (callback, value) => {
    try { callback?.(value); } catch { /* UI callback failures must not leak a connection. */ }
  };
  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    notify(onStatus, next);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(retryTimer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    signal?.removeEventListener('abort', stop);
    setStatus('closed');
  };
  const authError = (httpStatus) => {
    stop();
    notify(onAuthError, {
      token,
      status: httpStatus,
      code: 'FORBIDDEN',
      message: '세션이 만료되었거나 접근 권한이 없습니다. 다시 로그인해 주세요.',
    });
  };
  const cancelBody = (response) => {
    try { void response.body?.cancel().catch(() => {}); } catch { /* Already closed. */ }
  };
  const connect = async () => {
    if (stopped) return;
    try {
      const query = new URLSearchParams({ storeId: storeId.trim() });
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/kds/stream?${query}`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token.trim()}`,
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (stopped) {
        cancelBody(response);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        cancelBody(response);
        authError(response.status);
        return;
      }
      if (!response.ok) {
        cancelBody(response);
        throw streamError(`실시간 주문 연결에 실패했습니다. (HTTP ${response.status})`, 'HTTP_ERROR', response.status);
      }
      if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '') || !response.body) {
        cancelBody(response);
        throw streamError('실시간 주문 응답 형식을 확인해 주세요.', 'INVALID_RESPONSE', response.status);
      }
      const parser = createSseParser({
        onId: (id) => { lastEventId = id; },
        onEvent: (event) => {
          if (stopped || event.name === 'connect') return;
          if (event.name !== 'new-order' || (event.id && seenIds.has(event.id))) return;
          let order;
          try {
            order = JSON.parse(event.data);
            if (!order || typeof order !== 'object' || Array.isArray(order)) throw new Error('invalid order');
          } catch {
            notify(onError, streamError('실시간 주문 데이터 형식이 올바르지 않습니다.', 'INVALID_EVENT'));
            return;
          }
          if (event.id) {
            seenIds.add(event.id);
            if (seenIds.size > idLimit) seenIds.delete(seenIds.values().next().value);
          }
          notify(onOrder, order);
        },
      });
      const decoder = new TextDecoder();
      const activeReader = response.body.getReader();
      reader = activeReader;
      setStatus('open');
      try {
        while (!stopped) {
          const { value, done } = await activeReader.read();
          if (stopped) break;
          if (done) {
            parser.push(decoder.decode());
            break;
          }
          parser.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        if (reader === activeReader) reader = null;
        try { activeReader.releaseLock(); } catch { /* A canceled read may still be settling. */ }
      }
    } catch (failure) {
      if (stopped) return;
      notify(onError, failure?.code ? failure
        : streamError('실시간 주문 연결이 끊겼습니다. 다시 연결합니다.', 'NETWORK_ERROR'));
    }
    if (!stopped) {
      setStatus('reconnecting');
      if (!stopped) retryTimer = setTimeout(connect, Math.max(0, Number(retryMs) || 0));
    }
  };

  if (signal?.aborted) {
    stop();
    return stop;
  }
  signal?.addEventListener('abort', stop, { once: true });
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token.trim())) {
    authError(403);
    return stop;
  }
  if (typeof storeId !== 'string' || !storeId.trim() || typeof baseUrl !== 'string') {
    stop();
    notify(onError, streamError('매장 또는 API 서버 주소 설정을 확인해 주세요.', 'INVALID_INPUT'));
    return stop;
  }
  setStatus('connecting');
  void connect();
  return stop;
}
