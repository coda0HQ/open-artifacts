# Task 011: Design-register + both-theme + focus tests (RED)

**depends-on**: task-007-canvas-pins-impl, task-008-text-anchoring-impl, task-009-compose-create-ui-impl, task-010-drawer-delete-drift-impl

## Description

Write failing tests asserting the chrome design register for the new comment UI: markers, compose popover, and drawer use `tokens.css` tokens (not hardcoded hex), expose `:focus-visible` rings, and add no decorative motion beyond the existing drawer slide budget. Both light and dark are covered because tokens drive both themes.

## Execution Context

**Task Number**: 011 of 011 (test)
**Phase**: Refinement
**Prerequisites**: tasks 007/008/009/010 impl committed (all new UI exists to style).

## BDD Scenario

```gherkin
Scenario: Markers, popover, and drawer read in both themes and are keyboard-operable
  Given the host page is stamped with data-theme "light" and then with data-theme "dark"
  Then every pin, highlight, compose popover, and drawer control uses tokens for color in both themes
  And the compose input and the submit and delete controls show a visible focus ring on keyboard focus
  And a comment can be dropped, typed, submitted, and dismissed using the keyboard alone

Scenario: Attacker markup in the author name and body renders as text
  Given a comment on "art_1" whose author is the text "<img src=x onerror=alert(1)>"
  And whose body is the text "</script><script>alert(2)</script>"
  When the comment is rendered in the drawer
  Then the markup is shown as literal text and no script executes
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): CSS/markup assertions over the generated host page and frame document.

**Consumes**: the marker/popover/drawer CSS from tasks 007-010.

**Global Constraints respected**: tokens only; focus rings; no decorative motion; both themes.

## Files to Modify/Create

- Modify: `tests/worker/viewer.test.ts` (assert the comment CSS references `var(--accent`, `var(--surface`, `var(--border`, `var(--focus-ring`, `var(--danger` and no raw `#rrggbb` in the new marker/popover rules; assert `:focus-visible` present on compose input/submit/delete)

## Steps

### Step 1: Implement Test (Red)
- Grep the generated `.oa-cm-pin`, highlight, compose-popover, and delete-control CSS for token usage and `:focus-visible`; assert no hardcoded hex in those rules.
- Assert the compose popover input, submit, and delete controls carry a `var(--focus-ring)` focus style.
- Keyboard drop/submit/dismiss is browser-verified (noted).
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
```

## Success Criteria

- Design-register tests exist and fail before 011-impl.
