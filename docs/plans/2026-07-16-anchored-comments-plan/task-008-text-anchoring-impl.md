# Task 008: Text-range anchoring (GREEN)

**depends-on**: task-008-text-anchoring-test, task-007-canvas-pins-impl

## Description

Implement text-range anchoring in the frame bridge: capture a selection into a quote selector, re-anchor over `root.textContent` (exact → disambiguate → fuzzy → orphan), and render matches with the CSS Custom Highlight API (no DOM mutation). Orphaned anchors resolve to a drawer-only listing. The matcher is a ~150-line inline pure module (no dependency).

## Execution Context

**Task Number**: 008 of 011 (impl)
**Phase**: Anchoring
**Prerequisites**: task-008-text-anchoring-test committed and failing.

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
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (in the frame bridge, `src/wrap.ts`):
- `buildTextAnchor(fullText, start, end)` (pure)
- `reAnchor(fullText, anchor): {start,end} | "orphan"` (pure)
- a `renderHighlight(range)` using `CSS.highlights.set(...)`; `<mark>` fallback where unsupported.

**Consumes**: frame bridge `oa:arm`/`oa:anchor:new`/`oa:comments` (task 006).

**Global Constraints respected**: no DOM mutation of untrusted content (CSS Custom Highlight API); re-anchor deferred behind `requestIdleCallback`; orphan never dropped; no external dependency.

## Files to Modify/Create

- Modify: `src/wrap.ts` (frame bridge: `buildTextAnchor`, `reAnchor`, TreeWalker range mapping, `renderHighlight`, arm→selection capture)

## Steps

### Step 1: Implement Logic (Green)
- On `oa:arm` + selection: `buildTextAnchor(root.textContent, start, end)`; post `oa:anchor:new {anchor, point}` (point = selection rect for popover placement).
- On `oa:comments`: for each text comment with `anchorVersion ≤ viewedVersion`, run `reAnchor`; map char range → DOM `Range` via TreeWalker; `renderHighlight`; `"orphan"` → report to host for drawer-only listing (task 010).
- **Verification**: `pnpm test -- tests/worker/text-anchor.test.ts` PASSES.

### Step 2: Verify & Refactor
- Browser-verify selection→highlight and reflow stability via `/verify`. `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/text-anchor.test.ts
pnpm typecheck
```

## Success Criteria

- Selection builds a quote selector; re-anchor resolves/disambiguates/orphans correctly; highlights use the Custom Highlight API.
