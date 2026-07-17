# Task 011: Design-register styling (GREEN)

**depends-on**: task-011-design-register-test

## Description

Bring the new comment UI to the design register: restyle markers (pin/highlight), the compose popover, and the drawer additions to use `tokens.css` tokens only, expose `:focus-visible` rings on all interactive controls, ensure both themes read correctly, and keep motion within the existing drawer-slide budget. Confirm `textContent`-only escaping in the client renderer.

## Execution Context

**Task Number**: 011 of 011 (impl)
**Phase**: Refinement
**Prerequisites**: task-011-design-register-test committed and failing.

## BDD Scenario

```gherkin
Scenario: Markers, popover, and drawer read in both themes and are keyboard-operable
  Given the host page is stamped with data-theme "light" and then with data-theme "dark"
  Then every pin, highlight, compose popover, and drawer control uses tokens for color in both themes
  And the compose input and the submit and delete controls show a visible focus ring on keyboard focus
  And a comment can be dropped, typed, submitted, and dismissed using the keyboard alone
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/wrap.ts` CSS): token-based `.oa-cm-pin`, highlight, compose-popover, and delete-control styling; `:focus-visible { box-shadow: var(--focus-ring) }` on interactive controls.

**Consumes**: `tokens.css` bridge variables (`--accent`, `--accent-soft`, `--surface`, `--border`, `--focus-ring`, `--danger`), the marker/popover/drawer DOM from tasks 007-010.

**Global Constraints respected**: tokens only (no hardcoded hex); both themes; focus rings; no decorative motion; canvas pin styling documented in `references/canvas.md` (task 007).

## Files to Modify/Create

- Modify: `src/wrap.ts` (marker/popover/drawer CSS)
- Modify (if any residual per-artifact styling crept in): `skills/using-open-artifacts/references/canvas.md`

## Steps

### Step 1: Implement Logic (Green)
- Replace any hardcoded colors in the new UI with token vars; add `:focus-visible` rings; verify keyboard drop/submit/dismiss paths exist (Esc dismiss, Enter submit).
- Confirm client-render uses `textContent` (XSS scenario).
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` PASSES.

### Step 2: Verify & Refactor
- Browser-verify both themes + keyboard-only flow via `/verify`. Run the full suite `pnpm test` + `pnpm test:cli`; `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
pnpm test
pnpm typecheck
pnpm check
```

## Success Criteria

- All new UI is token-driven, both-theme correct, keyboard-operable, focus-ringed; full suite green.
