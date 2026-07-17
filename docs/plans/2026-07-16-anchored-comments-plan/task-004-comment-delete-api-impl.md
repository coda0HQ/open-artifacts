# Task 004: DELETE /comments/:commentId (GREEN)

**depends-on**: task-004-comment-delete-api-test

## Description

Add `DELETE /api/artifacts/:id/comments/:commentId`. Load the comment; 404 if missing or belonging to another artifact; authorize if the bearer token matches the comment's delete-token hash OR the artifact write/channel token; then delete.

## Execution Context

**Task Number**: 004 of 011 (impl)
**Phase**: Server API
**Prerequisites**: task-004-comment-delete-api-test committed and failing.

## BDD Scenario

```gherkin
Scenario: A delete with the wrong token is rejected
  Given "Dana" posted a comment "c_9" on "art_1"
  And a second viewer holds the delete token "dt_wrong" which does not match "c_9"
  When the second viewer attempts to delete "c_9" with the delete token "dt_wrong"
  Then the request is rejected with status 403
  And the comment "c_9" remains on "art_1"

Scenario: The artifact owner moderates any comment with the write token
  Given a viewer posted a comment "c_10" on "art_1"
  And the owner holds the artifact write token "wt_owner"
  When the owner deletes "c_10" with the write token "wt_owner"
  Then the comment "c_10" is removed from "art_1"

Scenario: Deleting a comment that belongs to a different artifact is not found
  Given a comment "c_x" exists on artifact "art_2"
  When a request is made to delete "c_x" under "/a/art_1"
  Then the request is rejected with status 404
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/api.ts`):
- `DELETE /api/artifacts/:id/comments/:commentId` → `200 {ok:true}` | `403` | `404`

**Consumes**: `getComment`/`deleteComment` (task 002); `bearerToken`, `sha256Hex`, `timingSafeEqual`, `authorizeWrite` (existing `src/api.ts:55-99`).

**Global Constraints respected**: timing-safe comparison; delete-token hash never leaves the server; legacy NULL-hash comments removable only via write token.

## Files to Modify/Create

- Modify: `src/api.ts` (add the DELETE route)

## Steps

### Step 1: Implement Logic (Green)
- `const c = await store.getComment(commentId)`; if `c === null || c.artifactId !== id` → `404`.
- Compute `matchDelete = c.deleteTokenHash !== null && timingSafeEqual(await sha256Hex(token), c.deleteTokenHash)`.
- Compute `matchOwner` via `authorizeWrite(c, store, id)` (write/channel token).
- If neither → `403`; else `deleteComment(commentId)` → `200 {ok:true}`.
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
pnpm typecheck
```

## Success Criteria

- Delete-own, wrong-token 403, owner-delete, and cross-artifact 404 all pass.
