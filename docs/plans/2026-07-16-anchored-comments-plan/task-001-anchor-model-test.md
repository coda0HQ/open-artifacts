# Task 001: Anchor model + validation tests (RED)

**depends-on**: _(none)_

## Description

Write failing unit tests for the anchor data model and its server-side validator in the domain layer: the discriminated-union `Anchor` shape, and `validateAnchor` rules for point mode (finite coords), text mode (length caps), the 2 KiB whole-anchor cap, and `anchorVersion`. Also cover `validateComment` accepting an optional anchor and defaulting a null anchor to unanchored.

## Execution Context

**Task Number**: 001 of 011 (test)
**Phase**: Foundation
**Prerequisites**: none — this is the first task.

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

**Exposes** (test-only): a `tests/worker/anchor.test.ts` suite exercising `validateAnchor` / `validateComment` directly.

**Consumes** (from task 001-impl, asserted to exist):
- `type Anchor = { mode: "point"; x: number; y: number; anchorVersion: number } | { mode: "text"; quote: string; prefix: string; suffix: string; start: number; anchorVersion: number }`
- `function validateAnchor(raw: unknown): Validated<Anchor>` (from `src/domain.ts`)
- `validateComment(body): Validated<CommentInput>` extended with `anchor` (from `src/domain.ts`)

**Global Constraints respected**: anchors validated server-side; both typecheck targets stay green.

## Files to Modify/Create

- Create: `tests/worker/anchor.test.ts`

## Steps

### Step 1: Verify Scenario
- Confirm the three validation scenarios above exist in the design `bdd-specs.md`.

### Step 2: Implement Test (Red)
- Assert `validateAnchor({mode:"point", x:"Infinity", y:0, anchorVersion:1})` returns `{ok:false, status:400}`; likewise for `NaN`, `Infinity` (number), and missing coords.
- Assert a `mode:"point"` anchor with finite integer `x,y` is accepted.
- Assert `mode:"text"` with a 1001-char `quote` is rejected; a `quote` ≤ 1000 with `prefix`/`suffix` ≤ 32 is accepted; a `prefix` of 33 chars is rejected.
- Assert an anchor whose `JSON.stringify(...).length` is 2049 is rejected.
- Assert `validateComment({body:"hi"})` yields `anchor: null` (unanchored); `validateComment({body:"hi", anchor:{mode:"point",x:1,y:2}})` yields a point anchor with `anchorVersion` defaulted to `CURRENT_ANCHOR_VERSION`.
- **Verification**: `pnpm test -- tests/worker/anchor.test.ts` MUST FAIL (symbols not yet exported / rules not implemented) with an assertion or type error, not a bare import crash once impl lands.

## Verification Commands

```bash
pnpm test -- tests/worker/anchor.test.ts
```

## Success Criteria

- The test file exists and fails meaningfully before 001-impl.
- Tests map 1:1 to the three validation scenarios plus the unanchored-default and text-cap cases.
