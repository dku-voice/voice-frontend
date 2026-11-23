import { supportedLanguage } from '../i18n/index.js';

// Only the confirmed top-level `language` field is added to the legacy event
// handling. Do not infer a new order protocol from unrecognized messages.
export function receiveVoiceMessage(raw, { voiceActive = false, currentLanguage = 'ko', onLanguage = () => {},
  onLanguageDetected = () => {}, canApplyLanguage = () => true } = {}) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI 서버 응답 형식이 올바르지 않습니다.');
  // A legacy order without a valid language must also release the
  // local window. Do not interpret unknown messages as a new order protocol.
  const isResult = Object.hasOwn(data, 'language') || data.type === 'order';
  const canApply = isResult && canApplyLanguage();
  const detected = voiceLanguage(data, currentLanguage);
  if (voiceActive && canApply && detected !== currentLanguage) onLanguage(detected);
  if (voiceActive && canApply && supportedLanguage(data.language)) onLanguageDetected(detected);
  return data;
}
export function voiceLanguage(data, current) {
  return supportedLanguage(data?.language) ? data.language : current;
}

// No IDs or extra fields are added to the wire protocol. One outstanding local
// window per socket covers the audio frames until an existing response arrives.
// A stale window suppresses ONLY automatic language changes, never order data.
export function createVoiceLanguageGuard() {
  let active = false;
  let session = 0;
  let selection = 0;
  const windows = new WeakMap();
  return {
    startSession() { active = true; session += 1; },
    stopSession() { active = false; session += 1; },
    manualSelection() { selection += 1; },
    audioSent(socket) {
      if (active && !windows.has(socket)) windows.set(socket, { session, selection });
    },
    hasPending(socket) { return windows.has(socket); },
    acceptResponse(socket) {
      const pending = windows.get(socket);
      windows.delete(socket);
      return active && Boolean(pending) && pending.session === session && pending.selection === selection;
    },
  };
}

// Existing worker output: mono 16 kHz signed Int16 PCM. This local activity
// estimate does not claim that server analysis has started and changes no bytes.
export const SPEECH_PAUSE_MS = 1600;
export function hasVoiceActivity(pcm) {
  const samples = pcm instanceof Int16Array ? pcm
    : pcm instanceof ArrayBuffer && pcm.byteLength % 2 === 0 ? new Int16Array(pcm) : null;
  if (!samples?.length) return false;
  let energy = 0;
  for (const value of samples) energy += (value / 32768) ** 2;
  return Math.sqrt(energy / samples.length) >= 0.01;
}

// Korean's five seconds is a non-destructive touch offer. Without a confirmed
// response language we must still allow 6–9s foreign results. Twelve seconds of
// response wait is a terminal timeout, measured after a local speech pause.
export function createVoiceWait({ onPending, onTouch, onTimeout = () => {}, onRecording = () => {}, onWaiting = () => {},
  onUtteranceEnd = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let phase = 'idle';
  let startedAt = null;
  let language = null;
  let generation = 0;
  let pendingTimer;
  let touchTimer;
  let expiryTimer;
  let silenceTimer;
  let touched = false;
  const clearTimers = () => {
    cancel(pendingTimer); cancel(touchTimer); cancel(expiryTimer); cancel(silenceTimer);
  };
  const arm = () => {
    clearTimers();
    const token = ++generation;
    const elapsed = now() - startedAt;
    const valid = () => token === generation && phase === 'waiting';
    const deadline = language === 'ko' ? 5000 : 12000;
    pendingTimer = schedule(() => { if (valid() && !touched) onPending(); }, Math.max(0, 3000 - elapsed));
    if (deadline < 12000) touchTimer = schedule(() => {
      if (!valid()) return;
      touched = true;
      onTouch({ language, deadline });
    }, Math.max(0, deadline - elapsed));
    expiryTimer = schedule(() => {
      if (!valid()) return;
      clearTimers();
      phase = 'expired';
      generation += 1;
      if (!touched) { touched = true; onTouch({ language, deadline: 12000 }); }
      onTimeout();
    }, Math.max(0, 12000 - elapsed));
  };
  const start = (nextLanguage) => {
    if (phase === 'waiting' || phase === 'expired') return;
    phase = 'waiting';
    language = supportedLanguage(nextLanguage) ? nextLanguage : null;
    startedAt = now();
    touched = false;
    arm();
    onWaiting();
  };
  return {
    start,
    audio(pcm, nextLanguage) {
      if (phase === 'expired') return;
      if (!hasVoiceActivity(pcm)) {
        if (phase === 'idle') start(nextLanguage);
        return;
      }
      const wasRecording = phase === 'recording';
      clearTimers(); generation += 1;
      phase = 'recording'; startedAt = null; touched = false;
      language = supportedLanguage(nextLanguage) ? nextLanguage : null;
      if (!wasRecording) onRecording();
      const token = generation;
      silenceTimer = schedule(() => {
        if (token === generation && phase === 'recording') {
          onUtteranceEnd();
          start(language);
        }
      }, SPEECH_PAUSE_MS);
    },
    changeLanguage(nextLanguage) {
      if (nextLanguage !== null && !supportedLanguage(nextLanguage)) return;
      language = supportedLanguage(nextLanguage) ? nextLanguage : null;
      if (phase === 'waiting') { touched = false; arm(); }
    },
    finish() {
      clearTimers(); generation += 1;
      phase = 'idle'; startedAt = null; touched = false;
    },
    get waiting() { return phase === 'waiting'; },
    get active() { return phase === 'waiting' || phase === 'recording'; },
    get expired() { return phase === 'expired'; },
    get phase() { return phase; },
    get touchAvailable() { return touched; },
  };
}

// A retry may need a fresh socket after retiring an expired one. Bound the
// connection wait separately from recognition wait; these are not AI messages.
export function waitForVoiceSocket(socket, { signal, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      for (const [event, handler] of [['open', opened], ['error', failed], ['close', failed]]) socket.removeEventListener(event, handler);
      signal?.removeEventListener('abort', aborted);
    };
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('AI 서버 연결 중 오류가 발생했습니다. 화면 터치로 주문할 수 있습니다.')); };
    const aborted = () => { cleanup(); reject(Object.assign(new Error('요청이 취소되었습니다.'), { name: 'AbortError' })); };
    if (signal?.aborted) { reject(Object.assign(new Error('요청이 취소되었습니다.'), { name: 'AbortError' })); return; }
    if (socket.readyState === 1) { resolve(); return; }
    if (socket.readyState !== 0) { failed(); return; }
    for (const [event, handler] of [['open', opened], ['error', failed], ['close', failed]]) socket.addEventListener(event, handler);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(failed, timeoutMs);
  });
}
