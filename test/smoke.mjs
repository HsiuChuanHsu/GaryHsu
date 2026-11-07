import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('both empty homepages render with base-aware language links', () => {
  const zh = readFileSync('dist/index.html', 'utf8');
  const en = readFileSync('dist/en/index.html', 'utf8');

  assert.match(zh, /lang="zh-Hant"/);
  assert.match(en, /lang="en"/);
  assert.match(zh, /href="\/GaryHsu\/en\/"/);
  assert.match(en, /href="\/GaryHsu\/"/);
  assert.doesNotMatch(zh, /href="\/GaryHsu\/(about|work)\/"/);
  assert.doesNotMatch(en, /href="\/GaryHsu\/en\/(about|work)\/"/);
});
