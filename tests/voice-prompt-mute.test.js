import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('음성 시작 안내 전에 마이크를 먼저 끄고 최대 시간이 지나면 다시 켠다', () => {
  const start = source.slice(source.indexOf('const startVoiceStreaming = async'), source.indexOf('const stopVoiceStreaming'));
  assert(start.indexOf('muteUntilPromptEnds();') !== -1);
  assert(start.indexOf('muteUntilPromptEnds();') < start.indexOf("speak('원하는 메뉴를 말씀해 주세요.');"));
  const mute = source.slice(source.indexOf('const muteUntilPromptEnds'), source.indexOf('const resumeMicAfterTts'));
  assert.match(mute, /pauseMicForTts\(\);/);
  assert.match(mute, /PROMPT_MUTE_LIMIT_MS/);
});

test('새 안내가 이전 안내를 끊을 때 이전 안내의 종료 신호로 마이크를 켜지 않는다', () => {
  const speak = source.slice(source.indexOf('const speak = (text) =>'), source.indexOf('const connectWebSocket'));
  const detach = speak.indexOf('ttsUtteranceRef.current = null;');
  const cancel = speak.indexOf('synthesis.cancel();');
  assert(detach !== -1 && detach < cancel);
  assert.match(speak, /if \(ttsUtteranceRef\.current !== utterance\) return;/);
});
