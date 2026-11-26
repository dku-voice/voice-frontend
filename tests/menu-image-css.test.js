import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');

test('메뉴 사진은 칸 밖으로 넘치지 않는다 (아이패드 사파리)', () => {
  const box = css.slice(css.indexOf('.item-image {'), css.indexOf('}', css.indexOf('.item-image {')));
  assert.match(box, /height: 72px;/);
  assert.match(box, /overflow: hidden;/);
  assert.match(css, /\.item-image img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: contain;/);
});
