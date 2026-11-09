import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from 'satteri';
import sectionRows from '../src/lib/section-rows.mjs';
import { readingPosition } from '../src/lib/reading-position.mjs';

test('reading position tracks chapters, clears old sections, and handles scrolling back', () => {
  const headings = [
    { level: 2, text: 'Overview', top: 100 },
    { level: 3, text: 'Background', top: 200 },
    { level: 2, text: 'Root Cause', top: 300 },
    { level: 3, text: 'Airflow 3', top: 400 },
  ];
  for (const [position, expected] of [
    [0, ['', '']],
    [100, ['Overview', '']],
    [200, ['Overview', 'Background']],
    [300, ['Root Cause', '']],
    [500, ['Root Cause', 'Airflow 3']],
    [150, ['Overview', '']],
  ]) {
    assert.deepEqual(readingPosition(headings, position), expected);
  }
  assert.deepEqual(readingPosition([], 500), ['', '']);
});

test('section rows preserve nested content and end before a new chapter', async () => {
  const { html } = await markdownToHtml('Intro\n\n### First\n\nBody\n\n#### Detail\n\n- Item\n\n### Second\n\nText\n\n## Next\n\nOutside', { hastPlugins: [sectionRows] });
  assert.match(html, /^<p>Intro<\/p>\s*<section class="section-row">/);
  assert.match(html, /<h4>Detail<\/h4>\s*<ul>\s*<li>Item<\/li>\s*<\/ul>\s*<\/div><\/section>\s*<section class="section-row"><h3>Second<\/h3>/);
  assert.match(html, /<p>Text<\/p>\s*<\/div><\/section>\s*<h2>Next<\/h2>\s*<p>Outside<\/p>/);
});

test('both homepages render with base-aware language links', () => {
  const zh = readFileSync('dist/index.html', 'utf8');
  const en = readFileSync('dist/en/index.html', 'utf8');

  assert.match(zh, /lang="zh-Hant"/);
  assert.match(en, /lang="en"/);
  assert.match(zh, /href="\/GaryHsu\/en\/"/);
  assert.match(en, /href="\/GaryHsu\/"/);
  assert.doesNotMatch(zh, /href="\/GaryHsu\/(about|work)\/"/);
  assert.doesNotMatch(en, /href="\/GaryHsu\/en\/(about|work)\/"/);
});

test('the Composer article renders in both languages with section rows and local diagrams', () => {
  for (const prefix of ['', 'en/']) {
    const html = readFileSync(`dist/${prefix}posts/composer-airflow-3-proxy-sendgrid/index.html`, 'utf8');
    assert.match(html, /class="section-row"/);
    assert.match(html, /<h3 id="airflow-3-改了架構">Airflow 3 改了架構<\/h3>\s*<div class="section-content">/);
    assert.match(html, /src="\/GaryHsu\/images\/composer-airflow-3\/airflow-3.png"/);
    assert.match(html, /<table>/);
    assert.match(html, /<pre /);
    assert.match(readFileSync(`dist/${prefix}index.html`, 'utf8'), /posts\/composer-airflow-3-proxy-sendgrid\//);
  }
});

test('the floating TOC links to article chapters and sections without including detail headings', () => {
  const html = readFileSync('dist/posts/composer-airflow-3-proxy-sendgrid/index.html', 'utf8');
  const targets = [...html.matchAll(/data-toc-heading="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.includes('root-cause'));
  assert.ok(targets.includes('airflow-3-改了架構'));
  assert.ok(!targets.includes('airflow-2'));
  assert.ok(!targets.includes('內容導覽'));
  assert.equal(new Set(targets).size, targets.length);
  for (const target of targets) assert.ok(html.includes(`id="${target}"`), `Missing heading: ${target}`);
  assert.match(html, /aria-controls="article-toc-list"/);
});
