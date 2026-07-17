# Task 005: Host/frame split (GREEN)

**depends-on**: task-005-host-frame-split-test

## Description

Split the viewer into a host page and an artifact frame. Add a host CSP/headers variant; extract `frameDocument()` (artifact body only) and rename `wrapDocument` → `hostShell()` (chrome + `<iframe>`); add the `GET /a/:id/frame` route; serve both `/a/:id` branches as host pages; fix `unlockShell` to build its `srcdoc` via `frameDocument` and stamp an inner `<meta>` CSP.

## Execution Context

**Task Number**: 005 of 011 (impl)
**Phase**: Viewer split
**Prerequisites**: task-005-host-frame-split-test committed and failing.

## BDD Scenario

```gherkin
Scenario: The host page and the artifact frame have different security envelopes
  Given the host page was served for "/a/art_1"
  And the artifact frame was served for "/a/art_1/frame"
  Then the host page response has "connect-src 'self'" and "frame-src 'self'" and no sandbox directive
  And the frame response has "sandbox allow-scripts" and "connect-src 'none'"
  And the frame's document origin is opaque

Scenario: The frame sub-route refuses to serve an encrypted artifact as plaintext
  Given an encrypted artifact "art_enc" exists
  When a request is made for "/a/art_enc/frame"
  Then the response status is 404
  And no plaintext artifact body is returned
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/wrap.ts`):
- `hostContentSecurityPolicy()` / `hostHeaders()` (sibling of `userContentHeaders`, `:73-88`)
- `frameDocument(options): string` (artifact body + reset/markdown CSS + bridge slot; no header/drawer/og)
- `hostShell(options): string` (crawler `<head>`, reused drawer + header, compose-popover CSS, host bridge, `<iframe src="/a/:id/frame">`)

**Consumes**: existing `wrapDocument` internals, `unlockShell`, `userContentHeaders`, `RESET_CSS`, `MARKDOWN_CSS`, `htmlHeaders`.

**Global Constraints respected**: frame CSP unchanged (`connect-src 'none'`, sandbox); host adds `connect-src 'self'` + `frame-src 'self'`; iframe positioned `top: var(--oa-header-h); inset-inline:0; bottom:0` (R3); `<meta>` CSP re-asserts `connect-src 'none'` on `srcdoc` (R2); no `allow-same-origin` on a same-origin frame (R1 — keep strict default here).

## Files to Modify/Create

- Modify: `src/wrap.ts` (add host CSP/headers; extract `frameDocument`; rename `wrapDocument`→`hostShell`; fix `unlockShell` `:612-740`)
- Modify: `src/index.ts` (`/a/:id` plain + encrypted branches → host page with `hostHeaders()`; add `app.get("/a/:id/frame", …)` `:83-165`)

## Steps

### Step 1: Implement Logic (Green)
- Add `hostContentSecurityPolicy()`/`hostHeaders()`.
- Extract `frameDocument(options)` from `wrapDocument`; rename the remainder to `hostShell(options)` with the `<iframe>`.
- `unlockShell`: build the injected `srcdoc` template via `frameDocument` (removing the current double header/drawer) and stamp the inner `<meta>` CSP.
- `src/index.ts`: both `/a/:id` branches return the host page with `hostHeaders()`; add `GET /a/:id/frame` returning `frameDocument()` with `userContentHeaders({sandbox:true, webFonts})`, `404` for encrypted.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` PASSES.

### Step 2: Verify & Refactor
- Run `pnpm test -- tests/worker/comments.test.ts` too (comment-inline assertions may have moved host↔frame); adjust as the design specifies. `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
pnpm test -- tests/worker/comments.test.ts
pnpm typecheck
```

## Success Criteria

- `/a/:id` is a host page; `/a/:id/frame` is the sandboxed artifact (404 encrypted); crawler metadata intact; no regressions.
