# Task 005: Host/frame split CSP + route tests (RED)

**depends-on**: _(none)_

## Description

Write failing tests asserting the viewer split: `/a/:id` returns a normal-origin host page (`connect-src 'self'`, `frame-src 'self'`, no `sandbox` directive, crawler `<head>` intact) embedding the artifact frame; `GET /a/:id/frame` returns the sandboxed artifact document (`sandbox allow-scripts`, `connect-src 'none'`) for plain artifacts and `404` for encrypted ones.

## Execution Context

**Task Number**: 005 of 011 (test)
**Phase**: Viewer split
**Prerequisites**: none (independent of the server-comment tasks).

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

Scenario: The host page still carries crawler metadata
  Given a crawler requests "/a/art_1"
  Then the response contains the artifact title and the "og:image" pointing at "/og/art_1"
  And the "og:url" points at "/a/art_1" and never at "/a/art_1/frame"
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): HTTP header + body assertions on `/a/:id` and `/a/:id/frame`.

**Consumes** (from task 005-impl):
- `GET /a/:id` → host page (host CSP)
- `GET /a/:id/frame` → frame document (user-content CSP) | `404` for encrypted

**Global Constraints respected**: frame keeps `connect-src 'none'` + opaque origin; host adds only `connect-src 'self'` + `frame-src 'self'`.

## Files to Modify/Create

- Modify: `tests/worker/viewer.test.ts` (move existing `connect-src 'none'`/`sandbox` assertions from `/a/:id` to `/a/:id/frame`; add host-page CSP + `<iframe>` + crawler-head assertions; add encrypted `/frame` → 404)

## Steps

### Step 1: Implement Test (Red)
- Assert `GET /a/:id` CSP header contains `connect-src 'self'` and `frame-src 'self'` and NOT `sandbox`; body contains the `<title>`, `og:image` = `/og/:id`, `og:url` = `/a/:id`, and an `<iframe` whose `src` is `/a/:id/frame`.
- Assert `GET /a/:id/frame` CSP header contains `sandbox allow-scripts` and `connect-src 'none'`; body contains the artifact content (`<h1>Wrapped</h1>` fixture) and no `og:`/title chrome.
- Assert `GET /a/:idEncrypted/frame` → `404`.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
```

## Success Criteria

- Split tests exist and fail before 005-impl.
