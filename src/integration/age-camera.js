export const ageCameraMessages = {
  UNSUPPORTED: '이 브라우저에서는 카메라를 사용할 수 없습니다. HTTPS 또는 localhost 환경과 카메라 지원 여부를 확인해 주세요.',
  PERMISSION_DENIED: '카메라 권한이 거부되었습니다. 권한을 허용하거나 기존 주문 방식을 이용해 주세요.',
  CAMERA_NOT_FOUND: '사용할 수 있는 카메라가 없습니다. 장치 연결을 확인해 주세요.',
  CAMERA_IN_USE: '카메라를 시작할 수 없습니다. 다른 앱에서 사용 중인지 확인해 주세요.',
  PERMISSION_TIMEOUT: '카메라 권한 응답 시간이 초과되었습니다. 권한을 확인한 뒤 다시 시도해 주세요.',
  PREVIEW_TIMEOUT: '카메라 미리보기를 시작하는 시간이 초과되었습니다. 다시 시도해 주세요.',
  VIDEO_NOT_READY: '카메라 영상이 아직 준비되지 않았습니다. 미리보기를 다시 열어 주세요.',
  CAPTURE_FAILED: '카메라 사진을 만들지 못했습니다. 카메라를 다시 열어 주세요.',
  CAPTURE_TIMEOUT: '카메라 사진을 준비하는 시간이 초과되었습니다. 다시 시도해 주세요.',
  ANALYSIS_TIMEOUT: '나이 분석 응답 시간이 초과되었습니다. 기존 주문 방식을 이용하거나 다시 시도해 주세요.',
  ANALYSIS_FAILED: '나이 분석에 실패했습니다. 화면 터치 또는 음성 주문을 계속 이용할 수 있습니다.',
  INVALID_RESPONSE: '나이 분석 결과 형식을 확인할 수 없습니다. 기존 주문 방식을 이용해 주세요.',
};

const cameraError = (code) => Object.assign(new Error(ageCameraMessages[code]), { cameraCode: code });
const canceled = () => Object.assign(new Error('카메라 작업이 취소되었습니다.'), { name: 'AbortError' });

// Camera resources and the single captured Blob stay local to this controller.
// Only analyze(), a separate explicit action after preview, calls the injected API.
export function createAgeCamera({
  getVideo = () => null,
  mediaDevices = () => globalThis.navigator?.mediaDevices,
  analyze: analyzeImage,
  onState = () => {},
  onResult = () => {},
  createCanvas = () => document.createElement('canvas'),
  timeoutMs = 30000,
  permissionTimeoutMs = 15000,
  captureTimeoutMs = 10000,
} = {}) {
  let state = { phase: 'idle', error: null, result: null };
  let epoch = 0;
  let operation = null;
  let preview = null;
  const stoppedTracks = new WeakSet();
  const snapshot = () => ({ ...state, error: state.error ? { ...state.error } : null, result: state.result ? { ...state.result } : null });
  const notify = (callback, value) => { try { callback(value); } catch { /* An observer cannot own camera resources. */ } };
  const publish = (next) => { state = next; notify(onState, snapshot()); };
  const alive = (op) => operation === op && epoch === op.epoch && !op.controller.signal.aborted;
  const stopStream = (stream) => {
    for (const track of stream?.getTracks?.() || []) {
      if (stoppedTracks.has(track)) continue;
      stoppedTracks.add(track);
      try { track.stop(); } catch { /* Keep stopping the other tracks. */ }
    }
  };
  const release = (resources) => {
    if (!resources || resources.released) return;
    resources.released = true;
    stopStream(resources.stream);
    // A late operation must never detach or pause a newer preview on this element.
    if (resources.video?.srcObject === resources.stream) {
      try { resources.video.pause?.(); } catch { /* Detach even if pause fails. */ }
      resources.video.srcObject = null;
    }
    if (preview === resources) preview = null;
  };
  const within = (op, promise, milliseconds, code) => new Promise((resolve, reject) => {
    const signal = op.controller.signal;
    let timer;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(canceled()); };
    // Observe even an already-created promise after cancellation. Its eventual
    // rejection must not escape as an unhandled rejection from an old task.
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (!alive(op)) { reject(canceled()); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(cameraError(code)); }, milliseconds);
  });
  const errorDetails = (error, kind) => {
    let code = error?.cameraCode;
    if (!Object.hasOwn(ageCameraMessages, code)) {
      if (kind === 'open') {
        if (['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) code = 'PERMISSION_DENIED';
        else if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) code = 'CAMERA_NOT_FOUND';
        else if (['NotReadableError', 'TrackStartError'].includes(error?.name)) code = 'CAMERA_IN_USE';
        else code = 'VIDEO_NOT_READY';
      } else if (state.phase === 'analyzing') {
        code = error?.code === 'TIMEOUT' ? 'ANALYSIS_TIMEOUT'
          : error?.code === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'ANALYSIS_FAILED';
      } else code = 'CAPTURE_FAILED';
    }
    return { code, message: ageCameraMessages[code] };
  };
  const fail = (op, error) => {
    if (!alive(op)) return;
    const details = errorDetails(error, op.kind);
    operation = null;
    op.controller.abort();
    release(op.resources);
    release(preview);
    publish({ phase: 'error', error: details, result: null });
  };
  const launch = (kind, phase, run) => {
    const op = { kind, epoch: ++epoch, controller: new AbortController(), resources: preview, promise: null };
    operation = op;
    op.promise = Promise.resolve().then(() => run(op)).catch((error) => {
      fail(op, error);
      return kind === 'open' ? false : null;
    });
    publish({ phase, error: null, result: null });
    return op.promise;
  };
  const open = () => {
    if (operation) return operation.kind === 'open' ? operation.promise : Promise.resolve(false);
    if (state.phase === 'preview' && preview) return Promise.resolve(true);
    return launch('open', 'opening', async (op) => {
      if (!alive(op)) return false;
      const devices = typeof mediaDevices === 'function' ? mediaDevices() : mediaDevices;
      if (!devices?.getUserMedia) throw cameraError('UNSUPPORTED');
      const requested = Promise.resolve().then(() => {
        if (!alive(op)) throw canceled();
        return devices.getUserMedia({ video: true, audio: false });
      }).then((stream) => {
        if (!alive(op)) { stopStream(stream); return null; }
        op.resources = { stream, video: null, released: false };
        preview = op.resources;
        return stream;
      });
      const stream = await within(op, requested, permissionTimeoutMs, 'PERMISSION_TIMEOUT');
      if (!alive(op) || !stream) return false;
      const video = getVideo();
      if (!alive(op)) return false;
      if (!video) throw cameraError('VIDEO_NOT_READY');
      op.resources.video = video;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await within(op, Promise.resolve().then(() => {
        if (!alive(op)) throw canceled();
        return video.play();
      }), captureTimeoutMs, 'PREVIEW_TIMEOUT');
      if (!alive(op)) return false;
      operation = null;
      publish({ phase: 'preview', error: null, result: null });
      return epoch === op.epoch && !op.controller.signal.aborted;
    });
  };
  const analyze = () => {
    if (operation) return operation.kind === 'analyze' ? operation.promise : Promise.resolve(null);
    if (state.phase !== 'preview' || !preview) return Promise.resolve(null);
    return launch('analyze', 'capturing', async (op) => {
      if (!alive(op)) return null;
      const video = op.resources?.video;
      const source = op.resources?.stream;
      const width = video?.videoWidth;
      const height = video?.videoHeight;
      const videoTracks = source?.getVideoTracks?.() ?? source?.getTracks?.().filter((track) => track.kind === 'video') ?? [];
      const currentData = Number.isFinite(video?.HAVE_CURRENT_DATA) ? video.HAVE_CURRENT_DATA : 2;
      // A disconnected camera can retain its last frame and nonzero dimensions.
      // Refuse that stale frame before allocating a canvas or sending an image.
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
        || source?.active === false || videoTracks.some((track) => track.readyState === 'ended')
        || (typeof source?.getVideoTracks === 'function' && videoTracks.length === 0)
        || (Number.isFinite(video?.readyState) && video.readyState < currentData)) throw cameraError('VIDEO_NOT_READY');
      let canvas;
      let context;
      let blob;
      try {
        canvas = createCanvas();
        if (!alive(op)) return null;
        const scale = Math.min(1, 1280 / width, 720 / height);
        canvas.width = Math.max(1, Math.floor(width * scale));
        canvas.height = Math.max(1, Math.floor(height * scale));
        context = canvas.getContext('2d');
        if (!context) throw cameraError('CAPTURE_FAILED');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (!alive(op)) return null;
        blob = await within(op, new Promise((resolve, reject) => {
          try { canvas.toBlob(resolve, 'image/jpeg', 0.86); } catch { reject(cameraError('CAPTURE_FAILED')); }
        }), captureTimeoutMs, 'CAPTURE_TIMEOUT');
        if (!alive(op)) return null;
        if (!(blob instanceof Blob) || blob.size === 0) throw cameraError('CAPTURE_FAILED');
      } finally {
        if (canvas) {
          try { context?.clearRect(0, 0, canvas.width, canvas.height); } catch { /* Reset dimensions as well. */ }
          canvas.width = 0;
          canvas.height = 0;
        }
        release(op.resources);
      }
      if (!alive(op)) return null;
      if (typeof analyzeImage !== 'function') throw cameraError('ANALYSIS_FAILED');
      publish({ phase: 'analyzing', error: null, result: null });
      if (!alive(op)) return null;
      let received;
      try {
        received = await within(op, Promise.resolve().then(() => {
          if (!alive(op)) throw canceled();
          return analyzeImage(blob, { signal: op.controller.signal });
        }), timeoutMs, 'ANALYSIS_TIMEOUT');
      } finally { blob = null; }
      if (!alive(op)) return null;
      if (!Number.isInteger(received?.estimatedAge) || received.estimatedAge < 0 || received.estimatedAge > 120
        || typeof received.ageGroup !== 'string' || typeof received.isSenior !== 'boolean') throw cameraError('INVALID_RESPONSE');
      const result = { estimatedAge: received.estimatedAge, ageGroup: received.ageGroup, isSenior: received.isSenior };
      operation = null;
      publish({ phase: 'success', error: null, result });
      if (epoch !== op.epoch || op.controller.signal.aborted) return null;
      notify(onResult, { ...result });
      return { ...result };
    });
  };
  const cancel = () => {
    const op = operation;
    operation = null;
    epoch += 1;
    op?.controller.abort();
    release(op?.resources);
    release(preview);
    if (state.phase !== 'idle' || state.error || state.result) publish({ phase: 'idle', error: null, result: null });
  };
  return { open, analyze, cancel, getState: snapshot,
    get busy() { return ['opening', 'preview', 'capturing', 'analyzing'].includes(state.phase); } };
}
