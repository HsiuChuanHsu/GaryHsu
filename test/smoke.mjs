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
  for (const [html, prefix] of [[zh, ''], [en, 'en/']]) {
    assert.doesNotMatch(html, /class="post-list"/);
    assert.doesNotMatch(html, /href="[^"]*\/posts\/[^"]+"/);
    assert.ok(html.includes(`<a href="/GaryHsu/${prefix}posts/">Posts</a>`));
    assert.ok(html.includes(`<a class="wordmark" href="/GaryHsu/${prefix}">Gary Hsu</a>`));
  }
});

test('post lists render separately with matching language links', () => {
  for (const [prefix, other] of [['', 'en/'], ['en/', '']]) {
    const html = readFileSync(`dist/${prefix}posts/index.html`, 'utf8');
    assert.match(html, /class="post-list"/);
    assert.ok(html.includes(`href="/GaryHsu/${prefix}posts/composer-airflow-3-proxy-sendgrid/"`));
    assert.ok(html.includes(`class="language" href="/GaryHsu/${other}posts/"`));
    assert.match(html, /<time datetime="2025-11-01T00:00:00\.000Z">2025\.11\.01<\/time>/);
  }
});

test('category lists filter posts and preserve the category when switching languages', () => {
  for (const [prefix, other] of [['', 'en/'], ['en/', '']]) {
    const all = readFileSync(`dist/${prefix}posts/index.html`, 'utf8');
    const rows = [...all.matchAll(/<li\b[^>]*>\s*<span class="post-category">(Work|Personal)<\/span>\s*<a href="[^"]*\/posts\/([^/]+)\/"/g)];
    const workIds = rows.filter((match) => match[1] === 'Work').map((match) => match[2]);
    for (const id of ['composer-airflow-3-proxy-sendgrid', 'keda-airflow-celery-worker-autoscaling', 'airflow-worker-groups-pr-comparison']) {
      assert.ok(workIds.includes(id), `${id} must appear in Work`);
    }
    for (const [category, label] of [['', 'All'], ['work/', 'Work'], ['personal/', 'Personal']]) {
      const html = readFileSync(`dist/${prefix}posts/${category}index.html`, 'utf8');
      assert.ok(html.includes(`href="/GaryHsu/${prefix}posts/${category}" aria-current="page">${label}</a>`));
      assert.ok(html.includes(`class="language" href="/GaryHsu/${other}posts/${category}"`));
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
      if (category) {
        assert.doesNotMatch(html, /class="post-category"/);
        const expectedIds = rows.filter((match) => match[1] === label).map((match) => match[2]);
        const ids = [...html.matchAll(/<li\b[^>]*>\s*<a href="[^"]*\/posts\/([^/]+)\/"/g)].map((match) => match[1]);
        assert.deepEqual(ids, expectedIds);
        if (expectedIds.length === 0) {
          assert.doesNotMatch(html, /class="post-list"/);
          assert.match(html, prefix ? /No posts in this category yet\./ : /這個分類還沒有文章。/);
        } else {
          assert.match(html, /class="post-list"/);
          const emptyMessage = html.match(/<p class="posts-empty"[^>]*>/)?.[0];
          if (emptyMessage) assert.match(emptyMessage, / hidden[ >]/);
        }
      }
    }
  }
});

test('only Work pages explain all four writing types before the article list', () => {
  for (const prefix of ['', 'en/']) {
    const html = readFileSync(`dist/${prefix}posts/work/index.html`, 'utf8');
    const explanation = html.match(/<section class="article-types"[\s\S]*?<\/section>/)?.[0];
    assert.ok(explanation, 'Work needs the article type explanation');
    for (const name of ['InGuide', 'InSolve', 'InInput', 'InSpec']) {
      assert.ok(explanation.includes(name));
      assert.ok(explanation.includes(`data-article-type="${name}" aria-pressed="false" aria-controls="work-post-list"`));
      const count = [...html.matchAll(/data-post-type="([^"]*)"/g)].filter((match) => match[1] === name).length;
      const button = explanation.match(new RegExp(`<button[^>]*data-article-type="${name}"[\\s\\S]*?</button>`))?.[0];
      assert.ok(button?.includes(`aria-label="${prefix ? 'Posts: ' : '文章數：'}${count}"`), `${name} needs its published post count`);
      const countLabel = prefix ? `${count} ${count === 1 ? 'post' : 'posts'}` : `${count} 篇`;
      assert.match(button, new RegExp(`class="type-count"[^>]*>${countLabel}</span>`));
    }
    assert.equal((explanation.match(/data-article-type=/g) ?? []).length, 4);
    assert.doesNotMatch(explanation, /data-article-type=""/);
    assert.match(html, /id="work-post-list"/);
    for (const name of ['InGuide', 'InSolve', 'InInput']) {
      assert.ok(html.includes(`data-post-type="${name}"`));
    }
    assert.match(html, /data-type-empty hidden/);
    for (const text of prefix
      ? ['Hands-on practice', 'Learning', 'Getting work done', 'Understanding and knowledge', 'Get me started', 'Help me solve it', 'Explain why', 'Find the specification']
      : ['動手實作', '學習', '完成工作', '理解與知識', '帶我入門', '幫我解題', '懂為什麼', '查什麼規格']) {
      assert.ok(explanation.includes(text), `Missing type explanation: ${text}`);
    }
    assert.ok(html.indexOf(explanation) < html.indexOf('<ol class="post-list"'));
    for (const route of ['index.html', 'posts/index.html', 'posts/personal/index.html']) {
      assert.doesNotMatch(readFileSync(`dist/${prefix}${route}`, 'utf8'), /class="article-types"/);
    }
  }
});

test('post type filters match exact types and clearing the filter restores every row', async () => {
  const { filterPostRows } = await import('../src/lib/filter-posts.mjs');
  const rows = ['InSolve', 'InGuide', 'InInput', undefined].map((postType) => ({ dataset: { postType }, hidden: false }));
  for (const [type, count, visibility] of [
    ['InGuide', 1, [false, true, false, false]],
    ['InSolve', 1, [true, false, false, false]],
    ['InInput', 1, [false, false, true, false]],
    ['InSpec', 0, [false, false, false, false]],
    ['', 4, [true, true, true, true]],
  ]) {
    assert.equal(filterPostRows(rows, type), count);
    assert.deepEqual(rows.map((row) => !row.hidden), visibility);
  }
  assert.equal(filterPostRows([], ''), 0);
});

test('the Composer article renders in both languages with section rows and local diagrams', () => {
  for (const prefix of ['', 'en/']) {
    const html = readFileSync(`dist/${prefix}posts/composer-airflow-3-proxy-sendgrid/index.html`, 'utf8');
    assert.match(html, /class="section-row"/);
    assert.match(html, /<h3 id="airflow-3-改了架構">Airflow 3 改了架構<\/h3>\s*<div class="section-content">/);
    assert.match(html, /src="\/GaryHsu\/images\/composer-airflow-3\/airflow-3.png"/);
    assert.match(html, /<table>/);
    assert.match(html, /<pre /);
    assert.ok(html.includes(`class="back" href="/GaryHsu/${prefix}posts/"`));
    assert.ok(html.includes('← Back to Posts</a>'));
    assert.match(html, prefix
      ? /<time datetime="2026-09-18T00:00:00\.000Z">September 18, 2026<\/time>/
      : /<time datetime="2026-09-18T00:00:00\.000Z">2026年9月18日<\/time>/);
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


test('Work sorting orders types then dates, keeps unknown types last, and restores time order', async () => {
  const { sortPostRows, filterPostRows } = await import('../src/lib/filter-posts.mjs');
  const rows = [
    ['solve', 'InSolve', '2026-11-02'],
    ['unknown', '', '2026-11-23'],
    ['guide-old', 'InGuide', '2026-01-01'],
    ['spec', 'InSpec', '2026-11-03'],
    ['input', 'InInput', '2026-11-04'],
    ['guide-new', 'InGuide', '2026-11-05'],
  ].map(([id, postType, postDate]) => ({ id, dataset: { postType, postDate }, hidden: false }));
  const category = sortPostRows(rows, 'category');
  assert.deepEqual(category.map(row => row.id), ['guide-new', 'guide-old', 'solve', 'input', 'spec', 'unknown']);
  filterPostRows(category, 'InGuide');
  assert.deepEqual(category.filter(row => !row.hidden).map(row => row.id), ['guide-new', 'guide-old']);
  const time = sortPostRows(category, 'time');
  assert.deepEqual(time.map(row => row.id), ['unknown', 'guide-new', 'input', 'spec', 'solve', 'guide-old']);
  assert.equal(filterPostRows(time, 'InSpec'), 1);
  assert.equal(filterPostRows(time, ''), 6);
  assert.deepEqual(sortPostRows([], 'category'), []);
});

test('All and Work lists render a labelled bilingual sort control and sortable dates', () => {
  for (const prefix of ['', 'en/']) {
    for (const category of ['', 'work/']) {
      const listId = category ? 'work-post-list' : 'all-post-list';
      const html = readFileSync(`dist/${prefix}posts/${category}index.html`, 'utf8');
      assert.match(html, /class="post-sort"/);
      assert.match(html, /<details class="post-sort" id="post-sort">/);
      assert.match(html, /<summary[^>]*aria-label="/);
      assert.match(html, /class="sort-menu" role="group"/);
      assert.match(html, /data-sort-label/);
      assert.doesNotMatch(html, /sort-segments/);
      assert.doesNotMatch(html, /<select/);
      assert.ok(html.includes(`type="radio" name="post-sort" value="time" aria-controls="${listId}" checked`));
      assert.ok(html.includes(`type="radio" name="post-sort" value="category" aria-controls="${listId}"`));
      assert.ok(html.includes(prefix ? 'Sort posts' : '排序'));
      assert.ok(html.includes(prefix ? '>Time</span>' : '>時間</span>'));
      assert.ok(html.includes(prefix ? '>Category</span>' : '>分類</span>'));
      assert.ok(html.includes(`data-sort-key="${category ? 'postType' : 'postCategory'}"`));
      if (!category) assert.match(html, /data-post-category="(work|personal)"/);
      assert.match(html, /data-post-date="\d{4}-\d{2}-\d{2}T/);
    }
    for (const route of ['posts/personal/index.html']) {
      assert.doesNotMatch(readFileSync(`dist/${prefix}${route}`, 'utf8'), /id="post-sort"/);
    }
  }
});


test('All category sorting groups Work before Personal with newest dates in each group', async () => {
  const { sortPostRows } = await import('../src/lib/filter-posts.mjs');
  const rows = [
    ['personal-new', 'personal', '2026-11-23'],
    ['work-old', 'work', '2026-01-01'],
    ['personal-old', 'personal', '2026-02-01'],
    ['work-new', 'work', '2026-11-01'],
  ].map(([id, postCategory, postDate]) => ({ id, dataset: { postCategory, postDate } }));
  const grouped = sortPostRows(rows, 'category', 'postCategory');
  assert.deepEqual(grouped.map(row => row.id), ['work-new', 'work-old', 'personal-new', 'personal-old']);
  assert.deepEqual(sortPostRows(grouped, 'time', 'postCategory').map(row => row.id), ['personal-new', 'work-new', 'personal-old', 'work-old']);
});
