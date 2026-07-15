# Task 003: POST /comments anchor + delete-token + encrypted-reject tests (RED)

**depends-on**: task-002-comment-store-impl

## Description

Write failing integration tests for the extended `POST /api/artifacts/:id/comments` route: it accepts an `anchor`, mints and returns a `deleteToken` (storing only its hash), rejects a `mode:"text"` anchor on an encrypted artifact, and still enforces the body size cap.

## Execution Context

**Task Number**: 003 of 011 (test)
**Phase**: Server API
**Prerequisites**: task-002-comment-store-impl committed.

## BDD Scenario

```gherkin
Scenario: A comment body larger than 8 KiB is rejected
  Given a create payload whose body is 8193 bytes
  When the payload is posted to "/api/artifacts/art_1/comments"
  Then the request is rejected for exceeding the size limit
  And no comment is stored

Scenario: An encrypted artifact accepts an unanchored comment but rejects a text anchor
  Given an encrypted artifact "art_enc" exists
  When an unanchored comment reading "nice work" is posted to "/api/artifacts/art_enc/comments"
  Then the comment is stored for "art_enc"
  When a text-anchored comment quoting "secret revenue $5M" is posted to "/api/artifacts/art_enc/comments"
  Then the request is rejected with status 400
  And no plaintext quote is stored for "art_enc"

Scenario: A persisted anchored comment reappears for a future viewer
  Given "Dana" posted a point-anchored comment on "art_1" at world x 100 y 100
  When a second viewer opens "/a/art_1" one hour later
  Then the second viewer sees Dana's comment in the drawer
  And a pin marker is rendered at world x 100 y 100 with no runtime fetch for the initial render
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): HTTP-level assertions against the Hono app for `POST /api/artifacts/:id/comments`.

**Consumes** (from task 003-impl):
- `POST /api/artifacts/:id/comments` accepts `{ author?, body, anchor?, anchorVersion? }` and returns `201 { ...CommentMeta, deleteToken }`.

**Global Constraints respected**: text-mode anchors rejected for encrypted artifacts (plaintext-leak guard); anchor validated server-side; body ≤ 8 KiB.

## Files to Modify/Create

- Modify: `tests/worker/comments.test.ts` (route-level anchor/deleteToken/encrypted cases)

## Steps

### Step 1: Implement Test (Red)
- POST a point-anchored comment to a plain artifact; assert `201`, response contains a `deleteToken` (non-empty string) and the stored `anchor` echoes back via `GET .../comments`.
- POST an unanchored comment to an encrypted artifact; assert `201`.
- POST a `mode:"text"` anchored comment to an encrypted artifact; assert `400` and that `GET .../comments` for that artifact contains no comment holding the quote.
- POST a body of 8193 bytes; assert rejection (413/size error) and nothing stored.
- **Verification**: `pnpm test -- tests/worker/comments.test.ts` MUST FAIL on the new cases.

## Verification Commands

```bash
pnpm test -- tests/worker/comments.test.ts
```

## Success Criteria

- New route tests exist and fail before 003-impl.
