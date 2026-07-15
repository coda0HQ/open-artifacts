# Task 009: Compose popover + create-flow + identity tests (RED)

**depends-on**: task-003-comment-create-api-impl, task-006-postmessage-bridge-impl

## Description

Write failing tests for the host-side create flow: a compose popover appears at the frame-reported point on `oa:anchor:new`, is prefilled from the saved display name, POSTs `{author, body, anchor, anchorVersion}` to the create route, stores the returned delete token in host `localStorage`, and posts the refreshed public list back into the frame. Assert the generated host script structure and (where extractable) pure helpers for the payload + storage keys.

## Execution Context

**Task Number**: 009 of 011 (test)
**Phase**: Host UI
**Prerequisites**: tasks 003-impl and 006-impl committed.

## BDD Scenario

```gherkin
Scenario: The author name comes from the locally saved display name
  Given the viewer has saved the display name "Dana" in host-page local storage
  When the viewer posts a comment reading "looks good"
  Then the stored comment's author is "Dana"
  And the display name was read from host-page local storage, not from the frame

Scenario: Post a point-anchored comment on a canvas artifact
  Given "art_1" is a canvas artifact whose plane transform is "matrix(2, 0, 0, 2, 100, 40)"
  And the viewer has armed the comment tool
  When the viewer clicks the canvas at client point x 300 y 240
  And types "this shape is off-center" and submits
  Then a comment is stored for "art_1" with a point anchor at world x 100 y 100
  And the point anchor records "anchorVersion" 3
  And a pin marker is rendered at that world point inside the frame
  And the host page performed the create request, not the frame
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): host-script structure assertions; optional pure `buildCreatePayload`/`displayNameKey` tests.

**Consumes** (from task 009-impl):
- host compose flow: `oa:anchor:new` → popover → `POST /api/artifacts/:id/comments` → store `deleteToken` → `oa:comments` back to the frame.

**Global Constraints respected**: display name from host `localStorage` (not the frame); delete token stored host-side, never sent to the frame; comment text typed into the host, not the untrusted frame.

## Files to Modify/Create

- Modify: `tests/worker/viewer.test.ts` (assert host page includes a compose popover with `var(--focus-ring)` input, a `localStorage` display-name read, and a create-`fetch` to `/api/artifacts/${id}/comments`)

## Steps

### Step 1: Implement Test (Red)
- Assert the host page markup/script contains a compose popover element (`position: fixed`) with an input carrying `var(--focus-ring)` focus style.
- Assert the host script reads a `localStorage` key for the display name and includes it as `author` in the create fetch body.
- Assert the create fetch targets `/api/artifacts/${id}/comments` (host, not frame) and stores the response `deleteToken` in `localStorage`.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
```

## Success Criteria

- Compose/create/identity tests exist and fail before 009-impl.
