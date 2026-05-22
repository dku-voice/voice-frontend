// =============================================================================
//  worker.js  --  WASM + Web Worker 기반 노이즈 캔슬링 적용 로직
//
//  AudioWorklet(pcm-capture-processor)이 캡처한 마이크 원시 PCM(Float32) 프레임을
//  메인 스레드를 거쳐 이 워커가 받아 디노이즈한 뒤 Int16 PCM 으로 돌려준다.
//  무거운 DSP 루프를 오디오 스레드/메인 스레드와 분리해 UI 끊김을 방지한다.
//
//    1순위: WebAssembly 노이즈 서프레서 (src/wasm/noise-suppressor.wat)
//    폴백 : 동일 알고리즘의 JavaScript 구현 (WASM 인스턴스화 실패 시)
//
//  메시지 프로토콜
//    수신  { type: 'configure', sampleRate }            -- 샘플레이트 설정/재초기화
//          { type: 'reduce-noise', pcm: Float32Array }  -- 디노이즈 요청
//    송신  { type: 'engine-ready', engine }             -- 'wasm' | 'js-fallback'
//          { type: 'noise-reduced', pcm: ArrayBuffer(Int16), sampleRate, engine }
// =============================================================================
import wasmUrl from './wasm/noise-suppressor.wasm?url';

let wasm = null; // { memory, init, process, bufferPtr }
let wasmReady = false;
let currentSampleRate = 16000;

// --- JS 폴백 DSP 상태 (WASM 모듈과 동일한 알고리즘) ---
const fb = {
  hpA: 0.96,
  hpPrevIn: 0,
  hpPrevOut: 0,
  envelope: 0,
  noiseFloor: 0.0001,
  gateGain: 0,
  attack: 0.0125,
  release: 0.00078,
  nfFall: 0.00042,
  nfRise: 0.0000156,
  gateCoef: 0.0042,
};
const RESIDUAL = 0.06;

const initFallback = (sampleRate) => {
  fb.hpA = Math.max(0.8, 1 - (2 * Math.PI * 90) / sampleRate);
  fb.attack = 1 / (0.005 * sampleRate);
  fb.release = 1 / (0.08 * sampleRate);
  fb.nfFall = 1 / (0.15 * sampleRate);
  fb.nfRise = 1 / (4 * sampleRate);
  fb.gateCoef = 1 / (0.015 * sampleRate);
  fb.hpPrevIn = 0;
  fb.hpPrevOut = 0;
  fb.envelope = 0;
  fb.noiseFloor = 0.0001;
  fb.gateGain = 0;
};

// WASM 모듈과 동일한 적응형 broadband noise suppressor (in-place)
const denoiseFallback = (samples) => {
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];

    const hp = fb.hpA * (fb.hpPrevOut + x - fb.hpPrevIn);
    fb.hpPrevIn = x;
    fb.hpPrevOut = hp;

    const level = Math.abs(hp);
    const envCoef = level > fb.envelope ? fb.attack : fb.release;
    fb.envelope += envCoef * (level - fb.envelope);

    const nfCoef = fb.envelope < fb.noiseFloor ? fb.nfFall : fb.nfRise;
    fb.noiseFloor += nfCoef * (fb.envelope - fb.noiseFloor);

    const snr = fb.envelope / (fb.noiseFloor + 1e-9);
    let target = (snr - 1.5) / (snr + 1.5);
    target = Math.max(0, Math.min(1, target));
    fb.gateGain += fb.gateCoef * (target - fb.gateGain);

    const gain = RESIDUAL + (1 - RESIDUAL) * fb.gateGain;
    samples[i] = hp * gain;
  }
  return samples;
};

const initWasm = async () => {
  try {
    const bytes = await fetch(wasmUrl).then((res) => res.arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, {});
    wasm = {
      memory: instance.exports.memory,
      init: instance.exports.init,
      process: instance.exports.process,
      bufferPtr: instance.exports.bufferPtr.value,
      capacity:
        (instance.exports.memory.buffer.byteLength - instance.exports.bufferPtr.value) >> 2,
    };
    wasm.init(currentSampleRate);
    wasmReady = true;
  } catch {
    wasm = null;
    wasmReady = false;
  }
  self.postMessage({ type: 'engine-ready', engine: wasmReady ? 'wasm' : 'js-fallback' });
};

// WASM 선형 메모리에 PCM 을 복사해 in-place 처리 후 결과 뷰 반환
const denoiseWasm = (samples) => {
  const view = new Float32Array(wasm.memory.buffer, wasm.bufferPtr, samples.length);
  view.set(samples);
  wasm.process(wasm.bufferPtr, samples.length);
  return view;
};

// Float32(-1..1) -> Int16 PCM
const floatToInt16 = (samples) => {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

const wasmInitPromise = initWasm();

self.onmessage = async (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'configure') {
    currentSampleRate = data.sampleRate || 16000;
    initFallback(currentSampleRate);
    await wasmInitPromise;
    if (wasmReady) wasm.init(currentSampleRate);
    return;
  }

  if (data.type !== 'reduce-noise' || !data.pcm) return;

  const samples =
    data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);

  let denoised;
  let engine;
  if (wasmReady && samples.length <= wasm.capacity) {
    denoised = denoiseWasm(samples);
    engine = 'wasm';
  } else {
    denoised = denoiseFallback(samples);
    engine = 'js-fallback';
  }

  const pcm16 = floatToInt16(denoised);
  self.postMessage(
    { type: 'noise-reduced', pcm: pcm16.buffer, sampleRate: currentSampleRate, engine },
    [pcm16.buffer],
  );
};
