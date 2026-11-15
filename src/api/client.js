export class ApiError extends Error {
  constructor(message, { code, status, serverMessage, cause } = {}) {
    super(message, { cause });
    this.name = 'ApiError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (serverMessage) this.serverMessage = serverMessage;
  }
}

const authMessage = '세션이 만료되었거나 접근 권한이 없습니다. 다시 로그인해 주세요.';

export function createApiClient({
  baseUrl = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  getAccessToken = () => null,
  onAuthError = () => {},
} = {}) {
  const origin = baseUrl.trim().replace(/\/+$/, '');
  let tokenGetter = getAccessToken;
  let authErrorHandler = onAuthError;

  const configureAuth = ({ getAccessToken: getter = tokenGetter, onAuthError: handler = authErrorHandler } = {}) => {
    tokenGetter = typeof getter === 'function' ? getter : () => null;
    authErrorHandler = typeof handler === 'function' ? handler : () => {};
  };

  const request = async (path, { method = 'GET', body, signal, token, auth = false } = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) {
      throw new ApiError('API 요청 경로를 확인해 주세요.', { code: 'INVALID_INPUT' });
    }
    if (signal?.aborted) throw new ApiError('요청이 취소되었습니다.', { code: 'ABORTED' });

    let requestToken = token;
    if (auth && requestToken === undefined) {
      try { requestToken = tokenGetter?.(); } catch { requestToken = null; }
    }
    if (requestToken != null && (typeof requestToken !== 'string' || /\s/.test(requestToken.trim()))) {
      throw new ApiError('인증 토큰 형식을 확인해 주세요.', { code: 'INVALID_INPUT' });
    }
    requestToken = typeof requestToken === 'string' ? requestToken.trim() : '';
    if (auth && !requestToken) {
      throw new ApiError('로그인이 필요합니다. 다시 로그인해 주세요.', { code: 'AUTH_REQUIRED', status: 401 });
    }

    let encodedBody;
    try { encodedBody = body === undefined ? undefined : JSON.stringify(body); } catch (cause) {
      throw new ApiError('API 요청 데이터 형식을 확인해 주세요.', { code: 'INVALID_INPUT', cause });
    }
    const controller = new AbortController();
    let abortCode;
    let rejectInterrupted;
    const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
    const abortError = (code, cause) => new ApiError(code === 'TIMEOUT'
      ? '서버 응답 시간이 초과되었습니다. 처리 결과를 확인한 뒤 다시 시도해 주세요.'
      : '요청이 취소되었습니다.', { code, cause });
    const interrupt = (code) => {
      if (abortCode) return;
      abortCode = code;
      controller.abort();
      rejectInterrupted(abortError(code));
    };
    const onAbort = () => interrupt('ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => interrupt('TIMEOUT'), timeoutMs) : null;

    const httpError = (response, serverMessage, cause) => {
      const forbidden = response.status === 403;
      const error = new ApiError(forbidden ? authMessage
        : serverMessage || `서버 요청에 실패했습니다. (HTTP ${response.status})`, {
        code: forbidden ? 'FORBIDDEN' : 'HTTP_ERROR', status: response.status, serverMessage, cause,
      });
      if (forbidden && requestToken) {
        // The UI can ignore a late 403 for a token that has already been replaced.
        // Keep it non-enumerable so serializing an error never prints the token.
        Object.defineProperty(error, 'token', { value: requestToken });
        try { Promise.resolve(authErrorHandler?.(error)).catch(() => {}); } catch { /* Preserve the API error. */ }
      }
      return error;
    };

    try {
      // One fetch per call, including POST. A timeout does not imply the server rolled back.
      const operation = (async () => {
        const response = await fetchImpl(`${origin}${path}`, {
          method,
          headers: {
            Accept: 'application/json',
            ...(encodedBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}),
          },
          ...(encodedBody !== undefined ? { body: encodedBody } : {}),
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw abortError(abortCode || 'ABORTED');
        let envelope;
        try {
          const contentType = response.headers.get('content-type');
          if (contentType && !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
            throw new Error('응답이 JSON이 아닙니다.');
          }
          envelope = await response.json();
        } catch (cause) {
          if (controller.signal.aborted) throw abortError(abortCode || 'ABORTED', cause);
          if (!response.ok) throw httpError(response, null, cause);
          throw new ApiError('서버 응답이 올바른 JSON 형식이 아닙니다. API 주소를 확인해 주세요.', {
            code: 'INVALID_RESPONSE', status: response.status, cause,
          });
        }
        if (controller.signal.aborted) throw abortError(abortCode || 'ABORTED');
        const serverMessage = typeof envelope?.message === 'string' && envelope.message.trim()
          ? envelope.message : null;
        if (!response.ok) throw httpError(response, serverMessage);
        if (!envelope || typeof envelope.success !== 'boolean') {
          throw new ApiError('서버 응답 형식이 올바르지 않습니다.', { code: 'INVALID_RESPONSE', status: response.status });
        }
        if (!envelope.success) {
          throw new ApiError(serverMessage || '서버에서 요청을 처리하지 못했습니다.', {
            code: 'API_ERROR', status: response.status, serverMessage,
          });
        }
        if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) {
          throw new ApiError('서버 응답에 결과 데이터가 없습니다.', { code: 'INVALID_RESPONSE', status: response.status });
        }
        return envelope.data;
      })();
      return await Promise.race([operation, interrupted]);
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (abortCode) throw abortError(abortCode, cause);
      if (cause?.name === 'AbortError') throw abortError('ABORTED', cause);
      throw new ApiError('서버에 연결할 수 없습니다. 네트워크와 API 서버 주소를 확인해 주세요.', {
        code: 'NETWORK_ERROR', cause,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  return { request, configureAuth };
}

export const apiClient = createApiClient({ baseUrl: import.meta.env?.VITE_API_BASE_URL || '' });
