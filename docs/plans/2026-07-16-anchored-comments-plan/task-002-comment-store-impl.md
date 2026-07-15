# Task 002: Comment store anchor + delete-token (GREEN)

**depends-on**: task-002-comment-store-test

## Description

Extend the D1 store: add the two nullable columns via idempotent ALTERs, persist/parse the anchor JSON, store the delete-token hash, and add `getComment`/`deleteComment`. Update `CommentRow`/`toComment` and the `ArtifactStore` interface.

## Execution Context

**Task Number**: 002 of 011 (impl)
**Phase**: Foundation
**Prerequisites**: task-002-comment-store-test committed and failing.

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

**Exposes** (from `src/store.ts`, updating the `ArtifactStore` interface):
- `addComment(artifactId: string, input: CommentInput, deleteTokenHash: string | null): Promise<CommentMeta>`
- `listComments(artifactId: string): Promise<CommentMeta[]>` (anchor parsed from JSON)
- `getComment(commentId: string): Promise<{ artifactId: string; deleteTokenHash: string | null } | null>`
- `deleteComment(commentId: string): Promise<void>`

**Consumes**: `Anchor`, `CommentInput`, `CommentMeta` (from `src/domain.ts`, task 001).

**Global Constraints respected**: idempotent-ALTER migration pattern (`src/store.ts:87`, swallowed by `isExpectedMigrationError`); no backfill; legacy NULL rows unanchored; no `any`.

## Files to Modify/Create

- Modify: `src/store.ts` (MIGRATIONS `:87`; `addComment` `:473`; `listComments`/`CommentRow`/`toComment` `:461-513`; add `getComment`/`deleteComment`)
- Modify: `src/store.ts` `ArtifactStore` interface (`:24-42`)

## Steps

### Step 1: Implement Logic (Green)
- Append to `MIGRATIONS`: `ALTER TABLE comments ADD COLUMN anchor TEXT` and `ALTER TABLE comments ADD COLUMN delete_token_hash TEXT`.
- `addComment` binds `input.anchor ? JSON.stringify(input.anchor) : null` and the passed `deleteTokenHash`; INSERT lists the two new columns.
- `listComments`/`toComment`: select `anchor`, `delete_token_hash`; `JSON.parse` anchor (null-safe) into `CommentMeta.anchor`; never expose the delete-token hash on `CommentMeta`.
- Add `getComment(id)` (`SELECT artifact_id, delete_token_hash WHERE id = ?`) and `deleteComment(id)` (`DELETE FROM comments WHERE id = ?`).
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
pnpm typecheck
```

## Success Criteria

- Store tests pass; anchor round-trips as an object; delete works; ALTERs are idempotent.
