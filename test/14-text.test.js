import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip } from '../src/utils/text.js';

const broken = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('clip never cuts an emoji or a Sinhala letter in half', () => {
  const s = 'Handmade 💖🇱🇰 batik 👩🏽‍🎨 ශ්‍රී ලංකා';
  for (let n = 1; n <= Array.from(s).length + 2; n++) assert.equal(broken(clip(s, n)), false, 'length ' + n);
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip(null, 5), '');
  assert.equal(clip('ab👕cd', 3), 'ab👕');
});
