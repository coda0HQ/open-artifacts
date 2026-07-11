# Interaction design patterns (Level 2+)

> Adapted from [impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0,
> Paul Bakaus) interaction-design and clarify references. Rewritten for this
> project's token contract and CSP constraints. See root README credits.

Read this before building any Level 2 or Level 3 artifact with interactive
controls. Every rule below is written on top of the token contract
(`references/tokens.css`): `var(--focus-ring)`, `var(--motion-fast)`,
`var(--danger)`, `var(--accent)`, `var(--space-*)`, etc. If a rule names a
token, use that token, not a raw value.

This file complements `design.md` (visual design, component recipes, ship gate)
and `motion.md` (animation timing and easing). Cross-references point to both
rather than duplicating their rules.

---

## The eight-state contract

Every interactive control passes through a subset of eight states. Ship all
states the control can reach before calling it done.

| State | Requirement | Notes |
| --- | --- | --- |
| Default | Always present. The resting visual. | |
| Hover | Pointer-only enhancement. Gate behind `@media (hover: hover)`. | Keyboard users never see hover. |
| Focus | `:focus-visible` ring, always. | See "Focus is visible, always" below. |
| Active / Pressed | Immediate feedback on pointer-down. | See "Press feedback" below. |
| Disabled | Visually muted, `aria-disabled` or `disabled`, not clickable. | Prefer explaining *why* over silent disabling. |
| Loading | Replaces content with a progress signal. | Never disable the control silently while loading. |
| Error | Field-level, with message. | See "Forms that respect the user" below. |
| Success | Confirmation that the action completed. | Transient (1.5-3s), then return to default. |

**Not every control needs all eight.** A static link needs Default, Hover,
Focus, Active. A form submit button needs all eight. A read-only badge needs
only Default. Map the reachable states per control, ship those, skip the rest.

This table ties to `design.md`'s "States are part of the contract" rule and
the ship gate's P0 requirement.

## Focus is visible, always

**Never remove the focus indicator.** A bare `outline: none` without a
replacement is an accessibility failure and a ship-gate blocker.

Use `:focus-visible` (not `:focus`) so mouse users skip the ring while
keyboard users always see it:

```css
button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

When using `outline` directly instead of `box-shadow`, spec it as
`2-3px solid` with `outline-offset: 2px` and a contrast ratio of at least
3:1 against the adjacent background. The token `var(--focus-ring)` uses a
solid accent edge separated from the surface by a background keyline, so it
meets this in the default themes. Recheck both adjacent surfaces when a
direction overrides `--accent`, `--bg`, or `--surface`.

**Dark theme check.** Verify the focus ring is visible on both `--bg` and
`--surface` backgrounds in dark mode. The token handles this, but custom
overrides can break it.

## Press feedback

**Respond on pointer-down, not pointer-up.** The user should feel the
control compress the instant they press, not after they release. This is the
difference between "responsive" and "laggy."

| Control type | Press feedback | Duration |
| --- | --- | --- |
| Compact (button, chip, toggle, icon) | `transform: translateY(1px)` | Instant (<80ms, no transition needed) |
| Large surface (card, list row, tile) | `transform: scale(0.97)` | ~160ms `var(--ease-standard)` |

```css
/* Compact controls — instant press */
.btn:active { transform: translateY(1px); }

/* Large clickable surfaces — scaled press */
.card-link:active {
  transform: scale(0.97);
  transition: transform 160ms var(--ease-standard);
}
```

Within the 80ms instant threshold, the user perceives no intermediate state,
so `translateY(1px)` needs no transition. For the scaled press on large
surfaces, the ~160ms transition makes the scale-down feel physical rather
than jumpy.

## Hit targets

**Minimum 44x44px touch target**, per WCAG 2.5.8 (Target Size). This applies
to every interactive element: buttons, links, form controls, icon actions.

When the visual element is smaller (an icon button, a compact chip), extend
the hit area with a pseudo-element:

```css
.icon-btn {
  position: relative;
}
.icon-btn::after {
  content: "";
  position: absolute;
  inset: -8px; /* extends hit area by 8px each side */
}
```

**Adjacent targets need spacing.** Two 44px targets with no gap between them
invite mis-taps. Ensure at least 8px (`var(--space-2)`) between adjacent
interactive elements, or use the pseudo-element inset technique so the visual
gap is larger while hit areas just touch.

The canvas runtime's zoom-cluster buttons are 44px. Frame labels counter-scale
via `transform` to stay legible at any zoom, so they remain tappable without
needing the pseudo-element extension.

## Hover is an enhancement

**Gate all hover styles behind `@media (hover: hover) and (pointer: fine)`.**
Touch devices with large pointers cannot dismiss a hover state, producing
"sticky hover" that confuses users.

```css
@media (hover: hover) and (pointer: fine) {
  .card:hover { background: var(--surface-2); }
}
```

**Any action revealed only on hover must have a non-hover path.** If a delete
button appears on card hover, it must also appear in a context menu, a
swipe, or always-visible on touch. Never hide the only path to an action
behind hover.

The canvas runtime's zoom cluster exemplifies this: hover styles are gated,
and zoom is always reachable via keyboard (`+`/`-`/`0`/`1`).

## Forms that respect the user

**Labels are visible, always.** A placeholder is not a label. Placeholder
text disappears on input, stranding the user without context. Every input
gets a `<label>` element above or beside it, associated via `for`/`id`.

**Validate on blur, not on every keystroke.** Per-keystroke validation fires
errors while the user is still typing, which is hostile. Wait for the field
to lose focus, then validate and show errors.

**Errors appear below the field**, use `var(--danger)` for color, and are
linked via `aria-describedby` so screen readers announce them:

```html
<label for="email">Email</label>
<input id="email" type="email" aria-describedby="email-err" />
<p id="email-err" class="field-error" role="alert">
  This email is already registered. Try signing in instead.
</p>
```

**Error messages follow the what/why/how pattern:**
1. **What** went wrong ("This email is already registered.")
2. **Why** it matters (implied or stated)
3. **How** to fix it ("Try signing in instead.")

Never use raw validation strings ("INVALID_FORMAT") or generic messages
("An error occurred"). The user deserves to know what happened and what to
do next.

## Waiting states

**Prefer skeleton screens over spinners.** A skeleton shaped like the final
layout gives the user a spatial preview of what is coming. A spinner
communicates "something is happening" with zero spatial information.

Shape skeletons to match the final layout: if the content is a card with a
title and two lines of text, the skeleton is a card-shaped container with
a title-width bar and two text-width bars at the correct spacing. Rounded
rectangles in `var(--surface-2)` with a subtle shimmer (a single
`translateX` animation on a pseudo-element gradient, gated behind
`prefers-reduced-motion: no-preference`).

**Optimistic UI only for low-risk, reversible actions.** A "like" toggle or
a comment post can update the UI before the server confirms, with a
rollback on failure. A payment, a deletion, or a permission change must wait
for confirmation. Never fake success for irreversible operations.

## Destructive actions

**Prefer undo over confirmation dialogs.** A confirmation dialog ("Are you
sure?") trains users to click "OK" reflexively. An undo toast ("3 files
deleted. Undo.") lets the action happen, gives a recovery window (5-8s),
and respects the user's initial intent.

Use a confirmation dialog only when:
- The action is truly irreversible (permanent delete with no recycle bin)
- The action is bulk and high-impact (deleting a project, revoking access)

**Button labels are verb-noun phrases.** "Delete 3 files", "Remove member",
"Cancel subscription". Never "OK", "Confirm", "Yes", "Submit". The label
tells the user exactly what will happen. Destructive buttons use
`var(--danger)` as their background with `var(--danger-on)` text, or as their
text color on a neutral surface, never the default accent.

## Overlays, done natively

**Use native `<dialog>` with `::backdrop`.** The `<dialog>` element handles
focus trapping, Escape-to-close, and backdrop rendering natively. No custom
overlay div, no manual focus management, no z-index wars.

```html
<dialog id="confirm-dialog">
  <h2>Delete project?</h2>
  <p>This cannot be undone.</p>
  <button onclick="this.closest('dialog').close()">Cancel</button>
  <button class="danger" onclick="handleDelete()">Delete project</button>
</dialog>
```

```js
document.getElementById('confirm-dialog').showModal();
```

**Use the Popover API for non-modal overlays** (menus, tooltips, pickers).
Popovers auto-dismiss on outside click and stack correctly without manual
z-index. For z-index layering beyond overlays, reference the semantic
staircase in `design.md` — do not duplicate it here.

**Mark obscured content as `inert`.** When a modal or sheet covers the page,
the content behind it should be `inert` so screen readers and keyboard
navigation skip it. Native `<dialog>` does this automatically; custom
overlays must set `inert` on the main content container.

## Keyboard reach

**Tab order must match reading order.** If the visual layout is
left-to-right, top-to-bottom, the tab sequence follows the same path. Never
use `tabindex` values greater than 0 to force a custom order; fix the DOM
order instead.

**Escape closes the topmost layer.** Always. Modal, dropdown, popover,
tooltip, drawer. The user should never be trapped in a layer with no
keyboard exit. Stack multiple layers and Escape peels them off one at a
time.

**Compound components use roving tabindex.** A toolbar, a radio group, a tab
list: one member is in the tab order (`tabindex="0"`), the rest are
`tabindex="-1"`. Arrow keys move focus within the group, Tab moves out to
the next control. This keeps the tab sequence short and navigable.

The canvas runtime exemplifies several of these rules: frame labels are in
DOM (reading) order, Escape always returns to the overview, and arrow keys
drive tour navigation or pan (depending on whether `data-tour` frames exist).

## Ship-gate hook

Before shipping any Level 2+ artifact, verify these interaction
requirements from this file (they join the `design.md` ship gate as P0):

- [ ] Every interactive control ships its reachable states from the
      eight-state contract above.
- [ ] `:focus-visible` ring is visible on both themes, on both `--bg` and
      `--surface` backgrounds.
- [ ] Touch targets are at least 44x44px (or extended via pseudo-element).
      Test at 360px viewport width.
- [ ] Every `<input>` has a visible `<label>`, not just a placeholder.
- [ ] Errors are below the field, use `var(--danger)`, and follow
      what/why/how.
- [ ] Escape closes the topmost overlay.
- [ ] Hover-revealed actions have a non-hover alternative path.
- [ ] Destructive buttons use verb-noun labels, never "OK" or "Confirm".
