# Task 004: DELETE /comments/:commentId authorization tests (RED)

**depends-on**: task-002-comment-store-impl, task-003-comment-create-api-impl

## Description

Write failing tests for the new `DELETE /api/artifacts/:id/comments/:commentId` route: delete-own with the matching delete token, rejection with a wrong token (403), owner moderation with the artifact write token, and not-found when the comment belongs to a different artifact (404).

## Execution Context

**Task Number**: 004 of 011 (test)
**Phase**: Server API
**Prerequisites**: task-002-comment-store-impl committed (getComment/deleteComment available).

## BDD Scenario

```gherkin
Scenario: Delete your own comment with its delete token
  Given the viewer posted a comment on "art_1" and holds the delete token "dt_abc" for it
  When the viewer deletes that comment with the delete token "dt_abc"
  Then the comment is removed from "art_1"
  And it no longer appears for a future viewer

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

**Exposes** (test-only): HTTP assertions on the DELETE route.

**Consumes** (from task 004-impl):
- `DELETE /api/artifacts/:id/comments/:commentId` with `Authorization: Bearer <token>`.

**Global Constraints respected**: timing-safe token comparison; legacy NULL-hash comments only owner-removable.

## Files to Modify/Create

- Modify: `tests/worker/comments.test.ts`

## Steps

### Step 1: Implement Test (Red)
- Create a comment, capture its `deleteToken`; DELETE with it → `200`/`{ok:true}`, gone from `GET`.
- DELETE the same comment id with a fabricated token → `403`, still present.
- DELETE a comment using the artifact's `writeToken` → success.
- DELETE a comment id that exists under a different artifact id → `404`.
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` MUST FAIL (route absent).

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
```

## Success Criteria

- DELETE-route tests exist and fail before 004-impl.
