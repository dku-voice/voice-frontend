const textSetting = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error('서버 주소 설정을 확인해 주세요.');
  return value.trim() || fallback;
};

const validateHttpSetting = (value, location, label) => {
  if (!value) return;
  let url;
  try {
    url = new URL(value, location?.origin || (location?.host ? `${location.protocol}//${location.host}` : 'http://localhost'));
  } catch {
    throw new Error(`${label} 주소 형식을 확인해 주세요.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} 주소 형식을 확인해 주세요.`);
  }
  if (location?.protocol === 'https:' && url.protocol === 'http:') {
    throw new Error(`보안 페이지에서는 ${label} 주소에 HTTPS를 사용해 주세요.`);
  }
};

export function resolveWebSocketUrl(value = '', location = globalThis.location) {
  const configured = textSetting(value);
  const origin = location?.origin || (location?.host ? `${location.protocol}//${location.host}` : undefined);
  if (!configured && !origin) return '';
  let url;
  try {
    url = new URL(configured || '/ws/audio', origin);
  } catch {
    throw new Error('음성 서버 주소 형식을 확인해 주세요.');
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('음성 서버 주소 형식을 확인해 주세요.');
  }
  if (location?.protocol === 'https:' && url.protocol !== 'wss:') {
    throw new Error('보안 페이지에서는 음성 서버 주소에 WSS를 사용해 주세요.');
  }
  return url.href;
}

export function createRuntimeConfig({ env = {}, location = globalThis.location } = {}) {
  const apiBaseUrl = textSetting(env.VITE_API_BASE_URL).replace(/\/+$/, '');
  const aiSnapshotUrl = textSetting(env.VITE_AI_SNAPSHOT_URL);
  validateHttpSetting(apiBaseUrl, location, 'API 서버');
  validateHttpSetting(aiSnapshotUrl, location, '사진 전송 서버');
  return {
    apiBaseUrl,
    aiWsUrl: resolveWebSocketUrl(env.VITE_AI_WS_URL, location),
    storeId: textSetting(env.VITE_STORE_ID, 'store-default'),
    // The legacy multipart contract is used only when explicitly configured.
    // The new age-analysis endpoint has no confirmed request/response schema.
    aiSnapshotUrl,
  };
}

export const runtimeConfig = createRuntimeConfig({ env: import.meta.env || {} });
