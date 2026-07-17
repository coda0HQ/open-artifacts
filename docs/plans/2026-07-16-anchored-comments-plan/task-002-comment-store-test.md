# Task 002: Comment store anchor + delete-token tests (RED)

**depends-on**: task-001-anchor-model-impl

## Description

Write failing D1-backed tests for the extended comment store: the two idempotent ALTER migrations (`anchor`, `delete_token_hash`), round-tripping an anchor through `addComment`/`listComments`, storing a delete-token hash, and the new `getComment`/`deleteComment` methods. Include back-compat: a legacy row with NULL anchor reads as unanchored.

## Execution Context

**Task Number**: 002 of 011 (test)
**Phase**: Foundation
**Prerequisites**: task-001-anchor-model-impl committed (Anchor type available).

## BDD Scenario

```gherkin
Scenario: A persisted anchored comment reappears for a future viewer
  Given "Dana" posted a point-anchored comment on "art_1" at world x 100 y 100
  When a second viewer opens "/a/art_1" one hour later
  Then the second viewer sees Dana's comment in the drawer
  And a pin marker is rendered at world x 100 y 100 with no runtime fetch for the initial render

Scenario: Delete your own comment with its delete token
  Given the viewer posted a comment on "art_1" and holds the delete token "dt_abc" for it
  When the viewer deletes that comment with the delete token "dt_abc"
  Then the comment is removed from "art_1"
  And it no longer appears for a future viewer
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): D1 round-trip assertions over `D1R2Store`.

**Consumes** (from task 002-impl):
- `addComment(artifactId, input, deleteTokenHash): Promise<CommentMeta>` (extended signature)
- `listComments(artifactId): Promise<CommentMeta[]>` returning parsed `anchor`
- `getComment(commentId): Promise<{ artifactId: string; deleteTokenHash: string | null } | null>`
- `deleteComment(commentId): Promise<void>`

**Global Constraints respected**: migrations use the idempotent-ALTER pattern; legacy NULL-anchor rows read as unanchored.

## Files to Modify/Create

- Modify: `tests/worker/comments.test.ts` (add store-level anchor + delete cases), or create `tests/worker/comment-store.test.ts` if cleaner.

## Steps

### Step 1: Implement Test (Red)
- Add a comment with a point anchor `{mode:"point",x:100,y:100,anchorVersion:1}` and a delete-token hash; assert `listComments` returns it with the anchor object parsed (not a string).
- Add an unanchored comment (anchor `null`); assert `listComments` returns `anchor: null`.
- Assert `getComment(id)` returns the artifactId + stored delete-token hash; `deleteComment(id)` removes it so `listComments` no longer includes it.
- Assert calling `ensureSchema` twice does not throw (idempotent ALTERs).
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` MUST FAIL on the new cases.

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
```

## Success Criteria

- New store-level tests exist and fail before 002-impl.
