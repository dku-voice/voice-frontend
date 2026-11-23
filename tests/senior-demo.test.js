import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('시연 모드는 기본으로 꺼져 있고 관리자 화면에서만 켤 수 있다', () => {
  assert.match(source, /const \[seniorDemo, setSeniorDemo\] = useState\(false\);/);
  const admin = source.slice(source.indexOf('const renderAdmin = () =>'));
  assert.match(admin, /checked=\{seniorDemo\}/);
  assert.match(admin, /시연 모드: 주문 시작 시 60세 이상 안내 표시/);
});

test('시연 모드가 켜지면 주문 시작 시 나이와 상관없이 60세 이상 안내를 띄운다', () => {
  const start = source.slice(source.indexOf('const startOrder = async'), source.indexOf('const returnToWelcome'));
  assert.match(start, /if \(seniorDemo \|\| result\?\.isSenior\) \{/);
  assert.ok(start.indexOf("setStartPhase('senior')") > start.indexOf('seniorDemo ||'));
});
