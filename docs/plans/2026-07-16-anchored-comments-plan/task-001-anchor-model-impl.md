# Task 001: Anchor type + validateAnchor (GREEN)

**depends-on**: task-001-anchor-model-test

## Description

Implement the `Anchor` discriminated-union type, the `validateAnchor` validator (mirroring `validateEncryption`), the anchor-related constants, and extend `CommentMeta`/`CommentInput` and `validateComment` to carry an optional anchor. Pure domain code — no infrastructure import.

## Execution Context

**Task Number**: 001 of 011 (impl)
**Phase**: Foundation
**Prerequisites**: task-001-anchor-model-test committed and failing.

## BDD Scenario

```gherkin
Scenario: A point anchor with a non-finite coordinate is rejected
  Given a create payload with a point anchor whose x is the string "Infinity"
  When the payload is posted to "/api/artifacts/art_1/comments"
  Then the request is rejected with status 400
  And no comment is stored

Scenario: A text anchor whose quote exceeds 1000 characters is rejected
  Given a create payload with a text anchor whose quote is 1001 characters long
  When the payload is posted to "/api/artifacts/art_1/comments"
  Then the request is rejected with status 400
  And no comment is stored

Scenario: An anchor JSON larger than 2 KiB is rejected
  Given a create payload whose serialized anchor is 2049 bytes
  When the payload is posted to "/api/artifacts/art_1/comments"
  Then the request is rejected with status 400
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/domain.ts`):
- `export const MAX_COMMENT_QUOTE_LENGTH = 1000`
- `export const MAX_COMMENT_QUOTE_CONTEXT_LENGTH = 32`
- `export const MAX_ANCHOR_BYTES = 2048`
- `export const CURRENT_ANCHOR_VERSION = 1`
- `export type Anchor = { mode: "point"; x: number; y: number; anchorVersion: number } | { mode: "text"; quote: string; prefix: string; suffix: string; start: number; anchorVersion: number }`
- `export function validateAnchor(raw: unknown): Validated<Anchor>`
- `CommentMeta` and `CommentInput` gain `anchor: Anchor | null`

**Consumes**: existing `Validated<T>`, `invalid()`, `contentByteLength` (from `src/domain.ts`).

**Global Constraints respected**: domain stays pure (no `store`/`api`/`wrap` import); `Number.isFinite` point-coord rule; length + 2 KiB caps; no `any` casts.

## Files to Modify/Create

- Modify: `src/domain.ts` (add constants, `Anchor`, `validateAnchor`; extend `CommentMeta`/`CommentInput`; wire `validateAnchor` into `validateComment` ~`:313`)

## Steps

### Step 1: Implement Logic (Green)
- Add the constants and `Anchor` type.
- Implement `validateAnchor` as a discriminated-union validator: `mode` must be `"point"` or `"text"`; point → `Number.isFinite(x)` and `Number.isFinite(y)` (reject strings/`NaN`/`Infinity`); text → `quote` length 1..1000, `prefix`/`suffix` optional strings ≤ 32, `start` optional non-negative integer; `anchorVersion` positive integer (default `CURRENT_ANCHOR_VERSION`); reject when `JSON.stringify(anchor).length > MAX_ANCHOR_BYTES`.
- Extend `CommentMeta`/`CommentInput` with `anchor`; in `validateComment`, validate an optional `body.anchor` (null/undefined → `anchor: null`).
- **Verification**: `pnpm test -- tests/worker/anchor.test.ts` PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` (both targets) and `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/anchor.test.ts
pnpm typecheck
pnpm check
```

## Success Criteria

- All 001 tests pass; both typecheck targets and biome are clean; `src/domain.ts` imports no infrastructure.
