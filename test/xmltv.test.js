import test from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/iptvout.js';

test('xml escaping handles markup characters', () => {
  assert.equal(esc(`Tom & Jerry <"quoted"> it's`), 'Tom &amp; Jerry &lt;&quot;quoted&quot;&gt; it&apos;s');
  assert.equal(esc(null), '');
  assert.equal(esc(1999), '1999');
});

test('control characters that XML 1.0 forbids are removed, normal whitespace is kept', () => {
  assert.equal(esc('Bad\u0001Title\u0008!'), 'BadTitle!');
  assert.equal(esc('line one\nline two\ttabbed'), 'line one\nline two\ttabbed');
  assert.equal(esc('ends\u0000here'), 'endshere');
});
