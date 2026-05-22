/* global AudioWorkletProcessor, registerProcessor */
// =============================================================================
//  pcm-capture-processor.js  --  마이크 원시 PCM(Float32) 캡처용 AudioWorklet
//
//  오디오 렌더링 스레드에서 마이크 입력을 128 샘플 단위로 받아 일정 길이
//  프레임으로 누적한 뒤, 가득 차면 메인 스레드로 transfer 한다.
//  노이즈 캔슬링 자체는 Web Worker + WASM 모듈(worker.js)이 담당하므로 여기서는
//  캡처/버퍼링만 수행한다. 출력은 무음으로 두어(에코 루프 방지) 오디오 그래프만
//  활성 상태로 유지한다.
//
//  AudioContext 가 ES module worklet 으로 로드하므로 import 없이 동작해야 한다.
// =============================================================================
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSize = options?.processorOptions?.frameSize || 4096;
    this._frameSize = frameSize;
    this._buffer = new Float32Array(frameSize);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this._buffer[this._offset] = channel[i];
      this._offset += 1;

      if (this._offset === this._frameSize) {
        const frame = this._buffer;
        // 버퍼 소유권을 워커 파이프라인으로 넘기고(transfer) 새 버퍼를 확보한다.
        this.port.postMessage(frame, [frame.buffer]);
        this._buffer = new Float32Array(this._frameSize);
        this._offset = 0;
      }
    }

    // outputs 미기록 = 무음 출력. true 반환으로 노드를 계속 활성 유지.
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
