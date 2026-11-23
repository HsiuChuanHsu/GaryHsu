# Post Categories Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add All / Work / Personal to the existing Posts list.

**Architecture:** Validate category metadata in the existing collection; filter in the shared posts helper. Render four static category routes through the shared Posts component and preserve list context on article return links.

**Tech Stack:** Astro 7.4.7, CSS, browser DOM APIs, Node test runner; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-post-categories-design.md`

## Global Constraints

- Homepages show no post lists; display Posts in the header.
- Keep article URLs and `/GaryHsu` base paths, date ordering, and draft exclusion.
- Work / Personal categorizes origin, including personal technical research.
- Empty categories remain reachable; language switching preserves category.

## Review Focus

Check Personal with a published fixture, draft exclusion, invalid category rejection, same-origin article return paths, and mobile/keyboard navigation.

### Task 1: Categorized post lists

**Files:** `src/content.config.ts`, existing blog frontmatter, `src/lib/site.ts`, `src/components/Posts.astro`, `src/components/Post.astro`, four static category route wrappers, `src/styles.css`, `test/smoke.mjs`, `README.md`.

**Interfaces:** `posts(category?: Category)` returns date-sorted published entries; `Posts` accepts `{ lang: Language; category?: Category }`.

- [x] Extend smoke checks for list membership, selected filters, bilingual category links, and empty states; run against current output and observe failures.
- [x] Require the category enum, migrate existing posts to Work, and implement the routes, list labels, responsive category links, and source-aware return link.
- [x] Run `npm test` and `git diff --check`; expect a successful build and all tests passing.
- [x] Use temporary Personal and draft fixtures plus an invalid category to verify publication and validation; remove fixtures and rebuild.
- [ ] Preview desktop/mobile layouts, click Work → article → return, switch category language, and check keyboard focus.
- [x] Review the complete diff and update this execution record. Leave changes on the existing feature branch without publishing.

## Execution record

User approved the preceding design with “go ahead”. Execute inline on `codex/separate-article-page`, preserving earlier changes in this session. This design and plan also record the agreed project notes.

Seven smoke tests pass, including All-only category labels and both language variants. Temporary published Personal and fourth Work fixtures also pass the suite; draft exclusion and invalid/missing category rejection were checked separately. All temporary fixtures were removed and the clean production output rebuilt.

The running Astro dev server held an old content schema that stripped category fields. Restarted the identified project process on port 4321 and verified live HTTP responses: All lists three labeled posts; both Work pages list three unlabeled posts; Personal displays its empty state.

A fresh read-only review found a brittle test that rejected future posts; the test was corrected and verified with additional fixtures. Fourteen built-script return-link checks passed. Minor unused `.writing` CSS remains deferred. Browser automation failed while obtaining tabs, so desktop/mobile rendering and physical keyboard interaction were not completed; the user's supplied screenshot confirmed the preceding Work layout.
