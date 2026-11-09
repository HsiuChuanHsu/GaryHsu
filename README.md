# Gary Hsu

Personal site and Markdown blog built with Astro.

## Develop

```sh
npm ci
npm run dev
npm test
```

## Add a post

Create `src/content/blog/my-post.md`:

```md
---
title: My post
date: 2026-11-07
lang: en
---

Write here.
```

Use `lang: zh` for a Traditional Chinese article. Both homepages list every published post. Add `draft: true` to keep a post out of the build. Filenames become article URLs; changing a filename changes its URL.

Use `##` for full-width article chapters and `###` for a left-hand section label. Content after each `###` renders in the right column until the next `###`, `##`, or `#`. Use `####` for headings inside that content. On narrow screens, the label stacks above the content. Ordinary Markdown images, lists, tables, and code blocks work inside each section.

Article contents are generated automatically from `##` and `###` headings. A compact 150px rail on the right expands on hover or click, links to each heading, and follows the current reading position. Use Escape or click outside to close it. No manual contents list is needed in the Markdown.

Edit `src/lib/site.ts` to add the Chinese and English about text or projects. Their navigation links appear when content is present. A project needs `name`, `description: { zh, en }`, and `url`.

## Publish

Push this project to the existing `HsiuChuanHsu/GaryHsu` GitHub repository on `main`, then select **GitHub Actions** as the Pages source. The workflow publishes to `https://HsiuChuanHsu.github.io/GaryHsu/`.
