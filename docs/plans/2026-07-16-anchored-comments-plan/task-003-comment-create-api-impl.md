# Task 003: POST /comments anchor + delete-token + encrypted-reject (GREEN)

**depends-on**: task-003-comment-create-api-test

## Description

Extend `POST /api/artifacts/:id/comments`: pass the validated anchor through, reject `mode:"text"` anchors when the artifact is encrypted, mint a `deleteToken` (store its SHA-256 hash), and return the token in the 201 body. Extend `GET .../comments` to include the anchor.

## Execution Context

**Task Number**: 003 of 011 (impl)
**Phase**: Server API
**Prerequisites**: task-003-comment-create-api-test committed and failing.

## BDD Scenario

```gherkin
Scenario: An encrypted artifact accepts an unanchored comment but rejects a text anchor
  Given an encrypted artifact "art_enc" exists
  When an unanchored comment reading "nice work" is posted to "/api/artifacts/art_enc/comments"
  Then the comment is stored for "art_enc"
  When a text-anchored comment quoting "secret revenue $5M" is posted to "/api/artifacts/art_enc/comments"
  Then the request is rejected with status 400
  And no plaintext quote is stored for "art_enc"

Scenario: A comment body larger than 8 KiB is rejected
  Given a create payload whose body is 8193 bytes
  When the payload is posted to "/api/artifacts/art_1/comments"
  Then the request is rejected for exceeding the size limit
  And no comment is stored
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/api.ts`):
- `POST /api/artifacts/:id/comments` → `201 { id, artifactId, author, body, anchor, anchorVersion, createdAt, deleteToken }`
- `GET /api/artifacts/:id/comments` → each comment includes `anchor`

**Consumes**: `validateComment`/`validateAnchor` (task 001), `addComment` (task 002), `generateWriteToken`/`sha256Hex` (existing `src/tokens.ts`/`src/api.ts`), `record.encrypted`.

**Global Constraints respected**: reject text anchor on encrypted; delete-token hash stored (plaintext returned once); no `any`.

## Files to Modify/Create

- Modify: `src/api.ts` (`POST /artifacts/:id/comments` `:372-394`; `GET` `:364-370`)

## Steps

### Step 1: Implement Logic (Green)
- After `validateComment`, if `parsed.value.anchor?.mode === "text"` and `record.encrypted`, return `400`.
- Mint `deleteToken = generateWriteToken()`; call `addComment(id, parsed.value, await sha256Hex(deleteToken))`.
- Return `201` with `{ ...comment, deleteToken }`.
- Ensure `GET .../comments` returns each comment's `anchor` (already via `listComments`).
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
pnpm typecheck
```

## Success Criteria

- Create route accepts anchors, returns a delete token, rejects encrypted text anchors, enforces the size cap.
