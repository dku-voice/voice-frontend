const TERMINAL_CAMERA_ERRORS = new Set(['UNSUPPORTED', 'PERMISSION_DENIED', 'CAMERA_NOT_FOUND']);

export function createAutoAgeMonitor({
  openCamera,
  analyzeCamera,
  cancelCamera,
  getCameraState = () => null,
  canRun = () => true,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (timer) => clearTimeout(timer),
  scanIntervalMs = 5000,
  retryIntervalMs = 8000,
} = {}) {
  let active = false;
  let generation = 0;
  let timer = null;

  const clearTimer = () => {
    if (timer !== null) cancelSchedule(timer);
    timer = null;
  };
  const stop = () => {
    active = false;
    generation += 1;
    clearTimer();
    cancelCamera?.();
  };
  const valid = (token) => active && token === generation && canRun();
  const queue = (token, delay) => {
    if (!valid(token)) return;
    clearTimer();
    timer = schedule(() => { timer = null; void scan(token); }, delay);
  };
  const scan = async (token) => {
    if (!valid(token)) { stop(); return; }
    let opened = false;
    let result = null;
    try {
      opened = Boolean(await openCamera?.());
      if (!valid(token)) return;
      if (opened) result = await analyzeCamera?.();
    } catch { /* The camera controller owns safe user-facing errors. */ }
    if (!valid(token)) return;
    if (!opened) {
      if (TERMINAL_CAMERA_ERRORS.has(getCameraState()?.error?.code)) {
        active = false;
        clearTimer();
        return;
      }
      queue(token, retryIntervalMs);
      return;
    }
    queue(token, result ? scanIntervalMs : retryIntervalMs);
  };
  const start = () => {
    if (active || !canRun()) return false;
    active = true;
    const token = ++generation;
    queue(token, 0);
    return true;
  };

  return {
    start,
    stop,
    get active() { return active; },
  };
}
