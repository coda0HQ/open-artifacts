# Task 010: Drawer open, delete UI, drift, orphan, back-compat (GREEN)

**depends-on**: task-010-drawer-delete-drift-test

## Description

Implement the host drawer behaviors: open a thread on `oa:anchor:open`; render delete controls when a delete token is held (or the owner write token is present); render the `· v{n}` drift tag; list orphaned text comments without a marker; render legacy unanchored comments unchanged; and build all client-side comment items with `textContent` (XSS-safe).

## Execution Context

**Task Number**: 010 of 011 (impl)
**Phase**: Host UI
**Prerequisites**: task-010-drawer-delete-drift-test committed and failing.

## BDD Scenario

```gherkin
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

**Exposes** (from `src/wrap.ts` host script):
- `oa:anchor:open` handler → open drawer to the thread
- comment-item renderer (`textContent`-only), drift tag, orphan listing, delete control gated on held delete token / owner write token
- `DELETE /api/artifacts/:id/comments/:commentId` call on delete

**Consumes**: `DELETE` route (task 004); the bridge `oa:anchor:open`/`oa:comments` (task 006); the compose flow (task 009).

**Global Constraints respected**: `textContent`-only render; legacy NULL-hash owner-only; `escapeHtml` on server-inlined first paint; only `anchorVersion ≤ viewedVersion` anchors get markers.

## Files to Modify/Create

- Modify: `src/wrap.ts` (host `COMMENTS_SCRIPT`: drawer open, item render, delete, drift/orphan; `commentsDrawerHtml` grouping if needed)

## Steps

### Step 1: Implement Logic (Green)
- Handle `oa:anchor:open {ids}` → open the drawer scrolled to that thread.
- Render each comment via `createElement` + `textContent`; add a delete button when `localStorage` holds its delete token or the owner write token is present; wire it to `DELETE`.
- Render a `· v{n}` tag when `anchorVersion !== viewedVersion`; list orphaned/newer-version comments without a marker.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
pnpm typecheck
```

## Success Criteria

- Marker-open works; delete controls gate correctly; drift/orphan/legacy render right; no XSS.
