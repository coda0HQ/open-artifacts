# Task 010: Drawer open, delete UI, version-drift, orphan, back-compat tests (RED)

**depends-on**: task-004-comment-delete-api-impl, task-009-compose-create-ui-impl

## Description

Write failing tests for the host drawer behaviors: clicking a marker opens the thread in the reused drawer; delete controls appear for comments whose delete token is held (and owner-delete via write token); a `· v{n}` drift tag renders when `anchorVersion ≠ viewedVersion`; orphaned text comments are listed without a marker; and legacy unanchored comments render with no marker and are owner-removable only. Also assert client-rendered comment fields are escaped (XSS).

## Execution Context

**Task Number**: 010 of 011 (test)
**Phase**: Host UI
**Prerequisites**: tasks 004-impl and 009-impl committed.

## BDD Scenario

```gherkin
Scenario: Clicking a marker opens that anchor's thread in the drawer
  Given "art_1" has a point-anchored comment "c_3" reading "fix this label" at world x 100 y 100
  And the drawer is closed
  When the viewer clicks the pin marker for "c_3"
  Then the frame sends an "oa:anchor:open" message identifying "c_3" to the host
  And the host opens the Phase-1 drawer scrolled to the thread for "c_3"

Scenario: A comment made against a newer version than the one being viewed is not anchored
  Given "art_1" has a point-anchored comment recorded against version 3
  When the viewer opens "/a/art_1" at version 2
  Then the comment is listed in the drawer without a pin marker
  And the comment card shows the tag "· v3"

Scenario: A legacy Phase-1 comment still renders and is owner-removable only
  Given "art_1" has a Phase-1 comment "c_legacy" whose anchor is NULL and whose delete-token hash is NULL
  When the viewer opens "/a/art_1"
  Then "c_legacy" appears in the drawer with no pin and no highlight
  And "c_legacy" cannot be deleted with any comment delete token
  But the owner can remove "c_legacy" with the write token "wt_owner"

Scenario: Attacker markup in the author name and body renders as text
  Given a comment on "art_1" whose author is the text "<img src=x onerror=alert(1)>"
  And whose body is the text "</script><script>alert(2)</script>"
  When the comment is rendered in the drawer
  Then the markup is shown as literal text and no script executes
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): drawer-render assertions (drift tag, orphan listing, legacy render, escaping) + `oa:anchor:open` handling.

**Consumes** (from task 010-impl):
- host drawer handlers for `oa:anchor:open`; delete controls; drift/orphan rendering.

**Global Constraints respected**: client render is `textContent`-only; legacy NULL-hash comments owner-removable only; delete token never crosses to the frame.

## Files to Modify/Create

- Modify: `tests/worker/viewer.test.ts` and/or `tests/worker/comments.test.ts` (drawer render + escaping assertions)

## Steps

### Step 1: Implement Test (Red)
- Assert an inlined comment with `anchorVersion 3` while the served version is `2` renders a `· v3` tag and no marker.
- Assert a legacy NULL-anchor comment renders without a marker and shows no delete control unless the owner write token is present.
- Assert an author/body containing `<img ... onerror=...>`/`</script>` is escaped (appears as literal text; the drawer builds items via `textContent`).
- Assert the host handles `oa:anchor:open` by opening the drawer to the identified thread.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
```

## Success Criteria

- Drawer/delete/drift/orphan/back-compat/XSS tests exist and fail before 010-impl.
