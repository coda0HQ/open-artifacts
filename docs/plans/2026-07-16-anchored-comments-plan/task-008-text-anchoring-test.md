# Task 008: Text quote-selector build + re-anchor matcher tests (RED)

**depends-on**: task-006-postmessage-bridge-impl

## Description

Write failing tests for the pure text-anchoring functions: building a quote selector from a selection (quote + 32-char prefix/suffix + start offset) and the re-anchor matcher (exact-with-context → position-disambiguated repeats → fuzzy-in-window → orphaned). These are the reflow/edit-robustness core and are fully unit-testable as pure string functions.

## Execution Context

**Task Number**: 008 of 011 (test)
**Phase**: Anchoring
**Prerequisites**: task-006-postmessage-bridge-impl committed.

## BDD Scenario

```gherkin
Scenario: Post a text-range comment on a normal page
  Given "art_1" is a normal HTML artifact containing the sentence "quarterly revenue grew 12% in Q3"
  And the viewer has armed the comment tool
  When the viewer selects the text "quarterly revenue grew 12%"
  And types "source for this?" and submits
  Then a comment is stored for "art_1" with a text anchor
  And the text anchor records the quote "quarterly revenue grew 12%"
  And the text anchor records a prefix of at most 32 characters and a suffix of at most 32 characters
  And a highlight marker covers "quarterly revenue grew 12%" inside the frame

Scenario: A duplicated quote is disambiguated by surrounding context
  Given "art_1" is a normal HTML artifact containing the word "Total" at character offset 40 and at character offset 900
  And a text comment quotes "Total" with the prefix and suffix taken from around character offset 900
  When the frame re-anchors the comment
  Then the highlight marker is placed at the occurrence at character offset 900

Scenario: A text anchor that no longer matches becomes orphaned but stays listed
  Given "Dana" posted a text comment on "art_1" quoting "the old pricing table" against version 2
  And "art_1" was republished at version 3 without the text "the old pricing table"
  When the viewer opens "/a/art_1" at version 3
  Then Dana's comment is listed in the drawer flagged as orphaned
  And no highlight marker is drawn for it
  And the comment card shows the tag "· v2"
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): unit tests for `buildTextAnchor` and `reAnchor`.

**Consumes** (from task 008-impl):
- `buildTextAnchor(fullText, start, end): { mode:"text"; quote; prefix; suffix; start; anchorVersion }` (pure)
- `reAnchor(fullText, anchor): { start: number; end: number } | "orphan"` (pure)

**Global Constraints respected**: prefix/suffix ≤ 32; quote ≤ 1000; matcher robust to reflow (text-only, no geometry).

## Files to Modify/Create

- Create: `tests/worker/text-anchor.test.ts` (pure matcher tests)

## Steps

### Step 1: Implement Test (Red)
- `buildTextAnchor("… quarterly revenue grew 12% in Q3 …", start, end)` yields the exact quote, prefix/suffix ≤ 32 chars, and the correct `start`.
- `reAnchor` finds a unique quote (exact) and returns its range.
- Two occurrences of "Total" (offsets 40 and 900): an anchor whose context matches offset 900 resolves to 900, not 40.
- A quote absent from the text returns `"orphan"`.
- A one-word edit near the quote still resolves via the fuzzy fallback (similarity ≥ 0.7).
- **Verification**: `pnpm test -- tests/worker/text-anchor.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/text-anchor.test.ts
```

## Success Criteria

- Matcher tests exist and fail before 008-impl.
