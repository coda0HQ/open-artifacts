# Task 009: Compose popover + create flow (GREEN)

**depends-on**: task-009-compose-create-ui-test, task-008-text-anchoring-impl

## Description

Implement the host-side compose + create flow: a `fixed` compose popover opened at the frame-reported point on `oa:anchor:new`, prefilled from the `localStorage` display name; on submit, POST the comment (with anchor) to the create route, persist the returned delete token in `localStorage`, and post the refreshed public comment list into the frame via `oa:comments`.

## Execution Context

**Task Number**: 009 of 011 (impl)
**Phase**: Host UI
**Prerequisites**: task-009-compose-create-ui-test committed and failing.

## BDD Scenario

```gherkin
Scenario: The author name comes from the locally saved display name
  Given the viewer has saved the display name "Dana" in host-page local storage
  When the viewer posts a comment reading "looks good"
  Then the stored comment's author is "Dana"
  And the display name was read from host-page local storage, not from the frame
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/wrap.ts` host script + CSS):
- compose popover DOM + CSS (`position:fixed`, token-styled, focus ring)
- host handler for `oa:anchor:new` → open popover; submit → `fetch(POST create)` → store `deleteToken` → `postMessage(oa:comments)` to the frame

**Consumes**: `POST /api/artifacts/:id/comments` (task 003); the bridge `oa:anchor:new`/`oa:comments` (task 006).

**Global Constraints respected**: identity in host `localStorage`; delete token host-only; popover token-styled + focus ring; host-side create throttle (reject a second create within 1.5 s / while in flight) per R5.

## Files to Modify/Create

- Modify: `src/wrap.ts` (host: compose-popover CSS + DOM in `hostShell`; upgrade `COMMENTS_SCRIPT` with the create flow + `localStorage` identity)

## Steps

### Step 1: Implement Logic (Green)
- On `oa:anchor:new {anchor, point}`: position the popover at `point` (+ header offset), prefill author from `localStorage`.
- On submit: `POST` `{author, body, anchor, anchorVersion}`; on 201, store `deleteToken` keyed by comment id; re-`GET` (or splice locally) and `postMessage({type:"oa:comments", list}, "*")` to the frame; update the drawer count.
- Apply the 1.5 s create throttle.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` PASSES.

### Step 2: Verify & Refactor
- Browser-verify the end-to-end drop→type→submit→pin flow via `/verify`. `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
pnpm typecheck
```

## Success Criteria

- Compose popover posts from the host with the saved display name; delete token stored host-side; frame receives the refreshed list.
