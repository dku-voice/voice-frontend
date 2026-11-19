import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTtsVoices, selectTtsVoice, ttsSettings, waitForTtsVoice } from '../src/integration/tts.js';

const voice = (name, lang, voiceURI = name, localService = true) => ({ name, lang, voiceURI, localService });

test('일본어·스페인어·태국어는 정확한 locale의 자연스러운 고품질 음성을 우선한다', () => {
  const voices = [
    voice('Kyoko', 'ja-JP', 'com.apple.voice.compact.ja-JP.Kyoko'),
    voice('Kyoko', 'ja_JP', 'com.apple.voice.premium.ja-JP.Kyoko'),
    voice('Mónica', 'es-ES', 'com.apple.voice.compact.es-ES.Monica'),
    voice('Elvira Natural', 'es_ES', 'Microsoft Elvira Online Natural', false),
    voice('Kanya', 'th-TH', 'com.apple.voice.compact.th-TH.Kanya'),
    voice('Kanya Enhanced', 'th_TH', 'com.apple.voice.enhanced.th-TH.Kanya'),
  ];
  assert.equal(selectTtsVoice(voices, 'ja', 'ja-JP').voiceURI, 'com.apple.voice.premium.ja-JP.Kyoko');
  assert.equal(selectTtsVoice(voices, 'es', 'es-ES').name, 'Elvira Natural');
  assert.equal(selectTtsVoice(voices, 'th', 'th-TH').name, 'Kanya Enhanced');
  assert.deepEqual(rankTtsVoices(voices, 'ja', 'ja-JP').map((item) => item.voiceURI),
    ['com.apple.voice.premium.ja-JP.Kyoko', 'com.apple.voice.compact.ja-JP.Kyoko']);
});

test('태국어 음성 목록이 늦게 준비돼도 voiceschanged를 기다려 Kanya를 선택한다', async () => {
  let voices = [];
  let listener;
  const synthesis = {
    getVoices: () => voices,
    addEventListener: (type, callback) => { assert.equal(type, 'voiceschanged'); listener = callback; },
    removeEventListener: (type, callback) => { assert.equal(type, 'voiceschanged'); assert.equal(callback, listener); },
  };
  const pending = waitForTtsVoice(synthesis, 'th', 'th-TH', 100);
  voices = [voice('Kanya Enhanced', 'th-TH', 'com.apple.voice.enhanced.th-TH.Kanya')];
  listener();
  assert.equal((await pending).name, 'Kanya Enhanced');
});

test('voiceschanged 이벤트가 없는 브라우저도 태국어 음성 목록을 다시 확인한다', async () => {
  let voices = [];
  const synthesis = { getVoices: () => voices };
  const pending = waitForTtsVoice(synthesis, 'th', 'th-TH', 300);
  setTimeout(() => { voices = [voice('Kanya', 'th-TH')]; }, 20);
  assert.equal((await pending).name, 'Kanya');
});

test('정확한 지역 음성이 없으면 같은 언어를 사용하고 지원 음성이 없으면 브라우저 기본값을 유지한다', () => {
  const voices = [voice('Paulina', 'es-MX'), voice('English', 'en-US')];
  assert.equal(selectTtsVoice(voices, 'es', 'es-ES').name, 'Paulina');
  assert.equal(selectTtsVoice(voices, 'ja', 'ja-JP'), null);
  assert.equal(selectTtsVoice(voices, 'ko', 'ko-KR'), null);
  assert.equal(selectTtsVoice(null, 'th', 'th-TH'), null);
});

test('외국어는 자연스러운 발화를 위해 소폭 조정하고 한국어 설정은 유지한다', () => {
  assert.deepEqual(ttsSettings('ko'), { rate: 1, pitch: 1 });
  assert.deepEqual(ttsSettings('ja'), { rate: 0.96, pitch: 1 });
  assert.deepEqual(ttsSettings('es'), { rate: 0.98, pitch: 1 });
  assert.deepEqual(ttsSettings('th'), { rate: 0.94, pitch: 1 });
  assert.deepEqual(ttsSettings('unknown'), { rate: 1, pitch: 1 });
});
