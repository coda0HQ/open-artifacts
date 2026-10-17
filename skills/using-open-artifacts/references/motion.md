# Motion patterns (Level 3)

> Sources: [open-design](https://github.com/nexu-io/open-design) motion
> system and native animation performance rules. See root README credits.

Level 3 artifacts use **native browser APIs only** — no Framer Motion, no
GSAP, no CDN scripts. The strict CSP (`script-src 'unsafe-inline';
default-src 'none'`) blocks all external requests, so every animation is
inline CSS + vanilla JS. This is the project's differentiator: library-free
motion that feels designed, not templated.

Read this only when the Recipe uses `artifact.level: 3`. Respect `prefers-reduced-motion`
at every level — wrap motion in a `@media (prefers-reduced-motion: no-preference)`
guard so reduced-motion users get the static version.

## The 6-step motion build sequence

Make decisions in the order that determines whether motion feels right. Two
failure modes exist, and the first is worse:
1. **Animating something that shouldn't animate.** A gate that produces zero
   lines of code is a success, not a dodge.
2. **Animating the right thing with the wrong ingredients** — `ease-in` on an
   entrance, `scale(0)`, keyframes on a rapid toggle, or a sluggish 400ms dropdown.

Run the sequence in order:

### 1. Should this animate at all?

Gate by frequency:

| Frequency | Examples | Motion budget |
| --- | --- | --- |
| 100+/day | keyboard shortcut, palette toggle, tab switch, filter | **None. Ever.** Jump to end state instantly (`ms = 0`). These are operated, not watched. |
| Dozens/day | dropdown, tooltip, menu, card hover | Near-imperceptible: <=150ms. Fast feedback only. |
| Several/day | modal open, drawer, route-like view transition | Standard UI duration: 180–300ms. |
| Rare / first-time | onboarding, empty-state reveal, victory moment | Delight permitted: 500–800ms. Richer choreography. |

**Keyboard-initiated actions are an absolute disqualifier, not a judgment call.**
Raycast has no open/close animation. Tab keys and command palettes must snap
instantly.

### 2. What is the purpose?

Name the purpose in one of these six words before writing code:
- **Feedback** — confirming the interface heard the user.
- **Spatial consistency** — showing where something arrived from or left to.
- **State indication** — making a status change visually legible.
- **Preventing a jarring change** — bridging content that would otherwise teleport.
- **Explanation** — demonstrating how a mechanism works (walkthroughs/demos).
- **Delight** — strictly restricted to the rare / first-time tier.

If you cannot name the purpose in one of these words, do not build the animation.
"It looks cool" on a tool surface is a reason to delete it.

### 3. Pick the tool — cheapest that works under strict CSP

Under Open Artifacts' opaque-origin sandbox and strict CSP, external packages
cannot be loaded. Use the cheapest native tool that satisfies the need:

| Need | Tool | Why |
| --- | --- | --- |
| Hover, press, color, class-toggled states | **CSS transition** | Interruptible, retargets mid-flight, zero JS overhead. |
| Entry animation on mount without JS state | **CSS `@starting-style`** | Modern native CSS entrance from initial values. |
| Predetermined motion during page load | **CSS animation** (`@keyframes`) | Runs off the main thread; stays 60fps while browser parses. |
| Dynamic, coordinate-driven, or cancelled JS motion | **WAAPI** (`element.animate()`) | Full programmatic control with native compositor speed. |

### 4. Pick the properties

- **`transform` and `opacity` only.** They bypass layout and paint entirely and
  run directly on the GPU compositor. `width`, `height`, `margin`, `padding`,
  `top`, and `left` force CPU layout reflows and drop frames.
- **Never `scale(0)`.** Start appearances from `scale(0.9–0.97)` + `opacity: 0`.
  Nothing in the physical world pops into existence from an infinitely small point.
- **Set `transform-origin` to the trigger.** A dropdown expands from its button;
  a popover blooms from its anchor. Center-origin is reserved for non-anchored modals.
- **Use percentages in `translate()` for self-size travel.** `translateY(100%)`
  slides an element by its own rendered height without JS measurements.
- **Never drive child transforms from CSS custom properties on a parent.**
  Updating `--x` on a parent forces style recalculation on every descendant.
  Apply `transform` directly to the animating element.

### 5. Easing and duration — or a spring

**Easing decision tree**:

| Situation | Easing curve | Notes |
| --- | --- | --- |
| Entering UI (appear, slide in) | `--ease-out` / `--ease-out-expo` | Strong deceleration (`cubic-bezier(0.23, 1, 0.32, 1)`). Fast arrival, gentle settle. |
| Exiting UI (dismiss, slide out) | `--ease-out` / `--ease-out-expo` | Still ease-out! Exits run ~75% of enter duration. |
| Moving / morphing on screen | `--ease-in-out` (`cubic-bezier(0.77, 0, 0.175, 1)`) | Dramatic in-out. Accelerates from rest, decelerates to stop. |
| Hover, color, opacity | `--ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`) | Subtle, predictable state shift. |
| Drawer / bottom sheet | `--ease-drawer` (`cubic-bezier(0.32, 0.72, 0, 1)`) | Soft iOS-like deceleration curve. |
| Progress / continuous meter | `linear` | Strictly for timed progress bars or steady tickers. |

**Never `ease-in` on UI entrances.** It starts slowly, delaying the exact
moment the user is watching. `ease-out` at 200ms feels snappier than `ease-in`
at 200ms.

**Duration ladder**:
- Button press feedback: **100–160ms**
- Tooltips, small popovers: **125–200ms**
- Dropdowns, selects: **150–250ms**
- Modals, drawers: **200–350ms**
- Layout shifts & View Transitions: **250–350ms**
- Load sequence (L3 hero only): **500–800ms**

**UI animations stay strictly under 300ms.** A 180ms dropdown feels responsive;
a 400ms dropdown feels broken.

### 6. Interruption, exits, and choreography

- **Transitions over keyframes for anything rapidly triggered.** Transitions
  retarget from the current value mid-flight. Keyframes restart from 0%.
- **Exit symmetric to entry.** If a notification slides in from the bottom, it
  dismisses downward through the bottom.
- **Direction-aware choreography.** Entering elements arrive following the eye's
  reading path (top-to-bottom or left-to-right). Stagger lists: max 3–5 items,
  delay 30–60ms per item. Never block interaction during stagger.

## Interruptibility

**Animate from the current rendered value, never from a fixed start.**
When a user grabs mid-flight, the animation stops where it is and input
takes over with no jump.

**Never lock input during an animation.** A tween that blocks pointer or
keyboard events forces the user to wait for your transition, which feels
broken.

**High-frequency triggers use `transition`, not `keyframes`.** A CSS
transition re-targets from its current interpolated value when the property
changes mid-flight; a `keyframes` animation restarts from `from{}`. For any
element the user can trigger faster than the animation completes (dropdowns,
tabs, hover states), prefer `transition` so a re-trigger reads as a smooth
course correction, not a stutter.

```css
/* Bad — keyframes restart on re-trigger */
.dropdown { animation: slide-down 200ms var(--ease-out-expo); }

/* Good — transition redirects mid-flight */
.dropdown { transition: transform 200ms var(--ease-out-expo),
                        opacity 200ms var(--ease-out-expo); }
```

The canvas runtime's mid-flight grab (pointerdown cancels the running
`requestAnimationFrame` loop and resumes from `view`'s current values) is
the JS equivalent of this rule.

## Transform origin and asymmetric timing

**Set `transform-origin` to the trigger.** A dropdown opens from its
toggle, a modal from the button that launched it, a tooltip from its anchor.
The eye tracks the cause, so motion should expand outward from there.
Exception: centered modals with no spatial trigger open from center.

**Asymmetric hold-to-action timing communicates consequence.** The pressing
phase is slow and deliberate (linear, 1.5-2s), giving the user time to
reconsider; the release on cancel is fast and forgiving (ease-out, 150-200ms).

```css
/* Hold-to-delete: slow fill = deliberate, fast drain = forgiving */
.hold-bar {
  transform-origin: left;
  transform: scaleX(0);
}
.hold-bar.pressing {
  transform: scaleX(1);
  transition: transform 2s linear;      /* slow, deliberate */
}
.hold-bar.released {
  transform: scaleX(0);
  transition: transform 200ms var(--ease-out-expo); /* fast, forgiving */
}
```

## Motion materials

Transform + opacity are the reliable defaults, not the whole palette.
Bounded `filter: blur()`, `clip-path` wipes, masks, and shadow/glow shifts
are legitimate premium materials when they materially improve the moment and
stay smooth. The rule is not "transform only" — it is: never animate
layout-driving properties (`top`/`left`/`width`/`height`/margins), keep
expensive paint areas small and isolated, and verify smoothness mentally on
a mid-range phone.

**Smooth height animations without layout thrashing**:
Never animate `height` or compute pixel heights in JS. Animate `grid-template-rows`
instead:
```css
/* Smooth accordion reveal using native CSS Grid */
.accordion-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 250ms var(--ease-out);
}
.accordion-content[data-open] {
  grid-template-rows: 1fr;
}
.accordion-inner {
  overflow: hidden;
}
```

**Keep `blur()` under 20px.** Larger radii are expensive to composite and
read as a rendering glitch rather than a material. 4-12px is the sweet spot
for depth-of-field effects.

**Use `translateY(100%)` for self-height sliding.** When an element's own
height is the travel distance (bottom sheet, notification toast), percentage
translate references the element's own box, so no JS measurement needed and
it stays correct as content resizes.

### Compositor performance & smooth 60fps execution

- **Preserve subpixel text anti-aliasing**: When scaling down or translating,
  compositing layers can occasionally soften text. Add `transform: translateZ(0)`
  or `backface-visibility: hidden` to keep rasterization crisp on GPU layers.
- **Batch measurements before mutations**: Never interleave `getBoundingClientRect()`
  or `offsetHeight` reads with DOM mutations in animation loops. Read once,
  compute offsets, then mutate in a single pass to eliminate forced layout reflows.
- **Judicious `will-change` usage**: Apply `will-change: transform, opacity`
  only during active animation cycles. Leaving `will-change` permanently on
  dozens of static elements consumes excessive GPU texture memory.

## Page-load sequence

Stagger elements in on first paint. The sequence is the thesis statement —
lead with the most characteristic thing.

```css
@keyframes rise-in {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: none; }
}
[data-rise] {
  opacity: 0;
  animation: rise-in 0.7s var(--ease-out-expo) forwards;
  animation-delay: calc(var(--i, 0) * 80ms);
}
@media (prefers-reduced-motion: reduce) {
  [data-rise] { opacity: 1; animation: none; }
}
```

```html
<h1 data-rise style="--i:0">Open Artifacts</h1>
<p  data-rise style="--i:1">An open-source…</p>
<div data-rise style="--i:2">…</div>
```

Keep the cascade under 6 items and total under 800ms — longer feels like a
loading screen, not an entrance. **Stagger delay 30-80ms per item, and never
block interaction on the stagger** — each element must be clickable as soon
as it paints, even if siblings are still animating in.

## Scroll-triggered reveals

**Read this before copying the snippets below:** a reveal must enhance an
already-visible default. Transitions pause on hidden tabs and in headless
renderers — and artifacts get rendered in exactly those contexts — so an
`opacity: 0` that only clears on `.in` can ship the section blank. Use **both**
gates together, not one or the other:

1. **`.js` capability class** (the primary gate): set the initial hidden state
   behind `.js [data-reveal]` (add `.js` to `<html>` as the first thing your
   script does). A viewer with JS off, or a headless renderer, never gets
   `.js`, so the static default is full visibility.
2. **`@media (prefers-reduced-motion: reduce)` override** (additive): inside
   that media query, force `.js [data-reveal]` to `opacity: 1` so a
   reduced-motion user with JS on still sees full content immediately, never
   the transition.

The reduced-motion override is **additive to** the `.js` gate, not a
substitute for it. Using only the media query still hides content on a JS-on,
reduced-motion-unset renderer that has not yet stamped the `.js` class.

`IntersectionObserver` + a class toggle. No scroll listeners, no jank.

```js
// Add the .js capability class to <html> as the FIRST thing your script does.
document.documentElement.classList.add('js');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
```

```css
/* Gate the hidden state on a capability class, never on the transition alone. */
.js [data-reveal] { opacity: 0; transform: translateY(24px); transition: opacity .7s var(--ease-out-expo), transform .7s var(--ease-out-expo); }
.js [data-reveal].in { opacity: 1; transform: none; }
/* Additive reduced-motion override: a reduced-motion user with JS on sees full content. */
@media (prefers-reduced-motion: reduce) {
  .js [data-reveal] { opacity: 1; transform: none; transition: none; }
}
```



**Stagger a list; don't stamp the page.** Staggering the items within one list
is legitimate. The tell is the uniform reflex — one identical entrance applied
to every section. Each reveal should fit what it reveals; suppressing the
reflex is not a reason to ship a page with no motion at all. Stagger children
inside a revealed section with `transition-delay: calc(var(--i) * 60ms)`.

## Scroll-driven animation (CSS only)

Modern CSS drives animation off scroll position with no JS. Use sparingly —
one per page.

```css
@keyframes parallax {
  from { transform: translateY(0); }
  to   { transform: translateY(-12%); }
}
.hero-bg {
  animation: parallax linear;
  animation-timeline: scroll();
  animation-range: 0 100vh;
}
```

`animation-timeline: view()` ties an element's entrance to its own scroll
position — great for pinned sections that progress as you scroll.

```css
@keyframes pin-progress {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}
.pinned-bar {
  transform-origin: left;
  animation: pin-progress linear;
  animation-timeline: view();
  animation-range: cover 0% cover 100%;
}
```

Browser support: Chromium and Safari (2026). Provide the `IntersectionObserver`
fallback above for the no-`scroll-timeline` path; don't feature-detect away
the whole effect — layer it.

## View Transitions

For state changes that should feel continuous (tab switches, route-like
navigation, filtering a grid). The API is `document.startViewTransition`:

```js
function swap(newHTML) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    container.innerHTML = newHTML;
    return;
  }
  document.startViewTransition(() => { container.innerHTML = newHTML; });
}
```

```css
::view-transition-old(root), ::view-transition-new(root) {
  animation-duration: 250ms;
  animation-timing-function: var(--ease-out-expo);
}
/* name a region so only it crossfades, not the whole page */
.tab-panel { view-transition-name: panel; }
```

## Hover micro-interactions

Restraint: one motion per element, 150ms, ease-out. The interaction signal,
not decoration.

```css
.card {
  transition: transform 150ms var(--ease-out-expo), box-shadow 150ms var(--ease-out-expo);
}
.card:hover { transform: translateY(-3px); box-shadow: var(--elev-raised); }
.card:active { transform: translateY(-1px); transition-duration: 80ms; }
```

Don't animate `box-shadow` directly on heavy elements — animate a pseudo-
element's opacity layered behind for better perf.

**Tooltip group-show pattern.** After the first tooltip in a group appears
(with its standard delay), subsequent tooltips in the same group show
instantly while the pointer stays in the group's region. This avoids
penalizing the user with repeated delays for sequential discovery. Reset
the delay when the pointer leaves the group entirely.

## Animated numerics

Count up on reveal. Use `requestAnimationFrame` with an ease-out curve, never
`setInterval`. Round to the precision the data warrants.

```js
function countUp(el, target, duration = 1200) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function frame(now) {
    const p = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(target * ease(p)).toLocaleString();
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
```

## Ambient atmosphere

One quiet ambient motion max per page — a slow gradient shift, a breathing
glow, a drifting particle field on canvas. It should read as atmosphere, not
as a loading state.

```css
@keyframes breathe {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50%      { opacity: 0.6; transform: scale(1.04); }
}
/* bezier inlined so this snippet works without the optional local token */
.glow { animation: breathe 8s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
```

## Anti-patterns

- Animating `top`/`left`/`margin` — use `transform` (and the bounded
  materials above).
- `linear` easing for organic motion; bounce/elastic anywhere.
- **`ease-in` (and ease-in-only curves) for UI.** It is the single most
  load-bearing slop tell — entrances accelerate *into* the destination and
  feel cheap. Entrances and emphasis use `--ease-out-expo`/`--ease-out`; in-view
  movement uses `--ease-in-out-quad`. Symmetric ambient loops may use a balanced
  in-out, never a bare ease-in.
- **Animating from `scale(0)` or `opacity:0`-only reveals.** Start appearances
  from `scale(0.9)`–`scale(0.97)` + `opacity:0` so the element has presence on
  the way in; `scale(0)` is a pop with no mass, and an opacity-only fade has no
  spatial read.
- `transition: all` — name the properties you mean; `all` animates layout and
  repaints cheaply-seeming things expensively.
- **Animation on keyboard-initiated or high-frequency (100+/day) actions.**
  Keyboard shortcuts and command-palette toggles are operated, not watched —
  remove the animation entirely; jump to the end state. Reserve motion for
  pointer-initiated or rare, deliberate actions.
- A `scroll` event listener — `IntersectionObserver`, `animation-timeline`,
  or nothing.
- Stagger cascades longer than 6 items or 800ms.
- Scroll-triggered theatre on a document (that's L3 for a landing page, not
  for an API reference).
- More than one ambient loop at a time.
- Motion that hides content from reduced-motion users — always provide the
  static endpoint.

### Fix priority

When auditing motion problems, fix in this order (highest damage first):

1. **Delete** — remove animations that have no one-sentence reason
2. **Reduce** — drop high-frequency actions to instant (frequency table)
3. **Fix easing** — replace `ease-in` and `linear` on organic motion
4. **Fix origin** — align transform-origin to the trigger
5. **Make interruptible** — switch keyframes to transitions where re-trigger is possible
6. **GPU-promote** — move layout-property animations to transform/opacity
7. **Asymmetric timing** — add deliberate/forgiving asymmetry to destructive holds
8. **Polish** — tune duration, add stagger, refine materials
9. **A11y** — verify reduced-motion path shows the static endpoint

## Budget

A Level 3 page should have **one orchestrated moment** (the load sequence or
a scroll-driven hero) and **quiet everything else**. Spend your boldness in
one place; ornament elsewhere reads as AI-slop. On a Canvas page
(references/canvas.md) that moment is the overview → focus zoom — don't also
stack scroll-reveal theatre inside frames, and there is no page scroll to drive
`animation-timeline: scroll()`. One orchestrated camera move, quiet frames.

**Motion matches the page's personality.** An editorial/documentation page
earns no bounce and no overshoot; a playful product launch may earn one
`--ease-spring` moment. The frequency table, duration ladder, and easing
decision tree above are constraints, not style — apply them within the page's
own voice.
