# Task 007: Canvas point-pin coord math + render tests (RED)

**depends-on**: task-006-postmessage-bridge-impl

## Description

Write failing tests for canvas point pins: the pure screen→world coordinate inversion, canvas-mode detection, and the `.oa-cm-pin` render structure (world-positioned, counter-scaled child of `#plane`). The coordinate math and detection are extracted as pure functions and unit-tested; the pin DOM/CSS structure is asserted in the generated frame document. Live pan/zoom behavior is browser-verified (noted below).

## Execution Context

**Task Number**: 007 of 011 (test)
**Phase**: Anchoring
**Prerequisites**: task-006-postmessage-bridge-impl committed.

## BDD Scenario

```gherkin
Scenario: Post a point-anchored comment on a canvas artifact
  Given "art_1" is a canvas artifact whose plane transform is "matrix(2, 0, 0, 2, 100, 40)"
  And the viewer has armed the comment tool
  When the viewer clicks the canvas at client point x 300 y 240
  And types "this shape is off-center" and submits
  Then a comment is stored for "art_1" with a point anchor at world x 100 y 100
  And the point anchor records "anchorVersion" 3
  And a pin marker is rendered at that world point inside the frame
  And the host page performed the create request, not the frame

Scenario: A pin stays a constant on-screen size while the canvas zooms
  Given "art_1" has a point-anchored comment at world x 100 y 100
  When the plane zooms from scale 1 to scale 4
  Then the pin marker remains centered on world x 100 y 100
  And the pin marker's on-screen size does not change
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): unit tests for `screenToWorld` and `detectCanvas`; frame-doc structure assertions.

**Consumes** (from task 007-impl):
- `screenToWorld(clientX, clientY, rect, k, tx, ty): { x: number; y: number }` (pure)
- the `.oa-cm-pin` CSS rule using `scale(1/var(--k)) translate(-50%,-50%)` appended to the frame document.

**Global Constraints respected**: pins are passive plane children (no polling); pin recipe documented in `references/canvas.md`.

## Files to Modify/Create

- Create: `tests/worker/canvas-anchor.test.ts` (pure math + frame-doc CSS assertions) — or `tests/cli/` if the helper is packaged for node.

## Steps

### Step 1: Implement Test (Red)
- Assert `screenToWorld(300, 240, {left:0,top:0}, 2, 100, 40)` returns `{x:100, y:100}` (from `(300-0-100)/2`, `(240-0-40)/2`).
- Assert `detectCanvas` returns true when `.oa-plane` has a non-`none` transform, false for `transform:none` (compact mode).
- Assert the frame document CSS contains `.oa-cm-pin` with `scale(calc(1 / var(--k` and `translate(-50%, -50%)` and `left: calc(var(--x)`.
- Note (browser-verify, not unit): constant on-screen size under zoom and pan-follow are validated via `/verify` or manual canvas interaction.
- **Verification**: `pnpm test -- tests/worker/canvas-anchor.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/canvas-anchor.test.ts
```

## Success Criteria

- Coordinate + detection + pin-CSS tests exist and fail before 007-impl.
