import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('노이즈 워커는 녹음 세대만 로컬로 되돌려 주고 기존 Int16 PCM 형식을 유지한다', async () => {
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  const source = (await readFile(new URL('../src/worker.js', import.meta.url), 'utf8'))
    .replace("import wasmUrl from './wasm/noise-suppressor.wasm?url';", "const wasmUrl = 'disabled-local-test.wasm';");
  vm.runInNewContext(source, { self, Float32Array, Int16Array, ArrayBuffer,
    fetch: async () => { throw new Error('use existing JS fallback without network'); } });
  await self.onmessage({ data: { type: 'configure', sampleRate: 16000 } });
  for (const generation of [1, 7]) {
    await self.onmessage({ data: { type: 'reduce-noise', pcm: new Float32Array([0.1, -0.1, 0, 0.2]), generation } });
    const result = messages.at(-1);
    assert.equal(result.type, 'noise-reduced'); assert.equal(result.generation, generation);
    assert.equal(result.sampleRate, 16000); assert.equal(result.pcm.byteLength, 8);
    assert(result.pcm instanceof ArrayBuffer);
  }
});
