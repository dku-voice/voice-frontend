export const AGE_ANALYSIS_PATH = '/ai/api/vision/analyze_age';

// Source defaults, used as a conservative client cap. Deployment may configure
// a different limit; the API's runtime limit is not exposed in OpenAPI.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const AGE_GROUPS = new Set(['child', 'adult', 'senior', 'unknown']);
const messages = {
  INVALID_IMAGE: '분석할 이미지 형식과 크기를 확인해 주세요.',
  ABORTED: '나이 분석 요청이 취소되었습니다.',
  TIMEOUT: '나이 분석 응답 시간이 초과되었습니다. 다시 시도하거나 터치 주문을 이용해 주세요.',
  ANALYSIS_FAILED: '나이 분석에 실패했습니다. 다시 시도하거나 기존 주문 방식을 이용해 주세요.',
  INVALID_RESPONSE: '나이 분석 서버 응답 형식이 올바르지 않습니다.',
  NETWORK_ERROR: '나이 분석 서버에 연결할 수 없습니다. 네트워크를 확인해 주세요.',
};

class AgeAnalysisApiError extends Error {
  constructor(code, status) {
    super(code === 'HTTP_ERROR' ? `나이 분석 서버 요청에 실패했습니다. (HTTP ${status})` : messages[code]);
    this.name = 'AgeAnalysisApiError';
    this.code = code;
    if (typeof status === 'number') this.status = status;
    this.requestPath = AGE_ANALYSIS_PATH;
    this.requestMethod = 'POST';
    // Do not retain image bytes, request bodies, raw server/model messages or
    // fetch causes on errors that may be rendered or recorded by the UI.
  }
}

const normalizeResult = (body) => {
  if (body?.status === 'error') throw new AgeAnalysisApiError('ANALYSIS_FAILED');
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.status !== 'success') {
    throw new AgeAnalysisApiError('INVALID_RESPONSE');
  }
  // The deployed schema allows null/omitted estimates. This is a valid response
  // without a usable analysis result, rather than a fabricated age or format error.
  if (body.estimated_age == null) throw new AgeAnalysisApiError('ANALYSIS_FAILED');
  if (!Number.isInteger(body.estimated_age) || body.estimated_age < 0 || body.estimated_age > 120) {
    throw new AgeAnalysisApiError('INVALID_RESPONSE');
  }
  const ageGroup = body.age_group === undefined ? 'unknown' : body.age_group;
  const isSenior = body.is_senior === undefined ? false : body.is_senior;
  if (!AGE_GROUPS.has(ageGroup) || typeof isSenior !== 'boolean') throw new AgeAnalysisApiError('INVALID_RESPONSE');
  // Keep server classifications as metadata. Never derive a threshold or mode
  // switch from the estimate, group, or is_senior here.
  return { estimatedAge: body.estimated_age, ageGroup, isSenior };
};

export function createAgeAnalysisApi({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  return {
    async analyze(imageBlob, { signal } = {}) {
      if (signal?.aborted) throw new AgeAnalysisApiError('ABORTED');
      if (!(imageBlob instanceof Blob) || !IMAGE_TYPES.has(imageBlob.type)
        || imageBlob.size <= 0 || imageBlob.size > MAX_IMAGE_BYTES) {
        throw new AgeAnalysisApiError('INVALID_IMAGE');
      }
      const form = new FormData();
      form.append('file', imageBlob, 'age-capture.jpg');
      const controller = new AbortController();
      let abortCode;
      let rejectInterrupted;
      const interrupted = new Promise((_resolve, reject) => { rejectInterrupted = reject; });
      const interrupt = (code) => {
        if (abortCode) return;
        abortCode = code;
        controller.abort();
        rejectInterrupted(new AgeAnalysisApiError(code));
      };
      const onAbort = () => interrupt('ABORTED');
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => interrupt('TIMEOUT'), deadlineMs);
      const checkCanceled = () => { if (abortCode) throw new AgeAnalysisApiError(abortCode); };
      try {
        // One user action produces at most one upload. The AI response is not
        // the ordering backend's {success,data,message} JSON envelope.
        const operation = (async () => {
          const response = await fetchImpl(AGE_ANALYSIS_PATH, {
            method: 'POST', credentials: 'omit', headers: { Accept: 'application/json' },
            body: form, signal: controller.signal,
          });
          checkCanceled();
          if (!response || typeof response.ok !== 'boolean') throw new AgeAnalysisApiError('INVALID_RESPONSE');
          if (!response.ok) throw new AgeAnalysisApiError('HTTP_ERROR', response.status);
          const contentType = response.headers?.get?.('content-type');
          if (contentType && !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
            throw new AgeAnalysisApiError('INVALID_RESPONSE');
          }
          let body;
          try { body = await response.json(); }
          catch {
            checkCanceled();
            throw new AgeAnalysisApiError('INVALID_RESPONSE');
          }
          checkCanceled();
          return normalizeResult(body);
        })();
        return await Promise.race([operation, interrupted]);
      } catch (failure) {
        if (abortCode) throw new AgeAnalysisApiError(abortCode);
        if (failure instanceof AgeAnalysisApiError) throw failure;
        if (failure?.name === 'AbortError') throw new AgeAnalysisApiError('ABORTED');
        throw new AgeAnalysisApiError('NETWORK_ERROR');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export const ageAnalysisApi = createAgeAnalysisApi();
