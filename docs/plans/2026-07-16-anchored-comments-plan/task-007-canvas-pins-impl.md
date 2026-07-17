# Task 007: Canvas point pins (GREEN)

**depends-on**: task-007-canvas-pins-test

## Description

Implement canvas point pins in the frame bridge: detect canvas mode, read the plane camera once via `DOMMatrixReadOnly`, invert screen→world on an armed click (capture phase), post `oa:anchor:new` out, and render each point comment as a passive `.oa-cm-pin` child of `#plane`. Document the pin recipe in `references/canvas.md`.

## Execution Context

**Task Number**: 007 of 011 (impl)
**Phase**: Anchoring
**Prerequisites**: task-007-canvas-pins-test committed and failing.

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

**Exposes** (in the frame bridge, `src/wrap.ts`):
- `screenToWorld(clientX, clientY, rect, k, tx, ty)` (pure)
- `detectCanvas(): boolean`; camera read via `new DOMMatrixReadOnly(getComputedStyle(plane).transform)` → `k=m.a, tx=m.e, ty=m.f`
- `.oa-cm-pin` CSS + a `renderPin(comment)` appending to `#plane`

**Consumes**: the frame bridge `oa:anchor:new`/`oa:comments` from task 006.

**Global Constraints respected**: read camera once at create (no polling); `.oa-cm-pin` counter-scaled unconditionally (decoupled from `CHIP_K`), uncapped `1/k`; capture-phase `stopPropagation()` so the runtime `tap()` doesn't intercept; canvas.md recipe (not a per-artifact patch).

## Files to Modify/Create

- Modify: `src/wrap.ts` (frame bridge: detection, `screenToWorld`, arm/capture-click, `.oa-cm-pin` CSS, `renderPin`)
- Modify: `skills/using-open-artifacts/references/canvas.md` (anchored-pin recipe beside the note-chip section)

## Steps

### Step 1: Implement Logic (Green)
- Add `detectCanvas`, `screenToWorld`, camera read.
- On `oa:arm` + next canvas click (capture phase, `stopPropagation`): compute the world point, post `oa:anchor:new {anchor:{mode:"point",x,y,anchorVersion}, point}`.
- On `oa:comments`: render/refresh `.oa-cm-pin` children of `#plane` for point comments with `anchorVersion ≤ viewedVersion`.
- Add the pin recipe to `canvas.md`.
- **Verification**: `pnpm test -- tests/worker/canvas-anchor.test.ts` PASSES.

### Step 2: Verify & Refactor
- Browser-verify constant-size-under-zoom + pan-follow via `/verify`. `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/canvas-anchor.test.ts
pnpm typecheck
```

## Success Criteria

- Point capture stores world coords; pins render as passive `#plane` children; canvas.md documents the recipe.
