# Motion patterns (Level 3)

> Sources: [open-design](https://github.com/nexu-io/open-design) motion
> system, Emil Kowalski's easing/frequency/duration rules. See root README
> credits.

Level 3 artifacts use **native browser APIs only** — no Framer Motion, no
GSAP, no CDN scripts. The strict CSP (`script-src 'unsafe-inline';
default-src 'none'`) blocks all external requests, so every animation is
inline CSS + vanilla JS. This is the project's differentiator: library-free
motion that feels designed, not templated.

Read this only when the Recipe uses `artifact.level: 3`. Respect `prefers-reduced-motion`
at every level — wrap motion in a `@media (prefers-reduced-motion: no-preference)`
guard so reduced-motion users get the static version.

## Every animation needs a one-sentence reason

Before adding motion, name what it communicates: hierarchy (directing the
eye), narrative (revealing in a sequence that matters), feedback
(acknowledging an action), or state (showing something changed). "It looks
cool" is not a reason; motion without a reason is the AI-generated feeling.

### Frequency table

The reason also gates the *budget*. Higher-frequency actions get less motion:

| Frequency | Examples | Motion budget |
| --- | --- | --- |
| 100+/day | keyboard shortcut, palette toggle, tab switch | **None.** Jump to end state instantly. These are operated, not watched (see Anti-patterns). |
| Dozens/day | dropdown, tooltip, hover reveal | Minimal, <=150ms. Feedback only. |
| Several/day | modal open, drawer, route change | Standard durations from the ladder below. |
| Rare / first-time | onboarding, empty-state reveal, first launch | Delight permitted. Longer durations, richer materials. |

When in doubt, one tier less motion than you think. The canvas runtime's
keyboard shortcuts (`0`/`F`/`Esc`/`1`/`+`/`-`) are all 100+/day tier and
jump instantly; the guided tour (occasional, deliberate) is the named
exception that earns a camera animation.

## Chrome / spatial camera budget

Applies to **viewer chrome and canvas chrome regardless of `artifact.level`**.
Product-register surfaces are operated mid-task; choreography is banned here
even on Level 3 pages.

| Scenario | Rule | Why |
| --- | --- | --- |
| Keyboard shortcut or tab-driven label focus moves the camera | Jump instantly (`ms = 0` / reduced-motion path) | 100+/day tier; animation makes the tool feel slow |
| Pointer fit into a frame or guided tour step | 400ms camera tween (already the canvas default); reduced-motion still instant | Occasional, deliberate travel; one orchestrated moment |
| Pointerdown while a tween or glide is running | Cancel the raf and resume from the current transform | Interruptibility is load-bearing; grabbing mid-flight must not jump |
| Theme toggle, zoom-cluster press, Esc to overview | No orchestrated sequence; at most `var(--motion-fast)` color/press feedback | Chrome is an instrument cluster, not a hero |
| Pinch past MIN/MAX | Elastic `rubber()` overshoot; `settle()` snaps `k` back | Hard clamp feels locked; pan already uses the same rubber |

Compact chrome buttons (zoom, tour, labels, chips) use
`transform: translateY(1px)` on `:active` — press feedback on pointer-down,
not a timed animation (see `interaction.md` Press feedback).

## Easing and duration

`--ease-out-expo` (settle, premium) and `--ease-spring` (overshoot, lively)
ship in the token contract — don't redefine them. Add locally if needed:

```css
--ease-in-out-quad: cubic-bezier(0.45, 0, 0.55, 1);  /* balanced, ambient */
--ease-in-out-strong: cubic-bezier(0.77, 0, 0.175, 1); /* dramatic in-out */
--ease-out-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* drawer / sheet */
```

### Easing decision tree

Pick by intent, not by feel:

| Intent | Token / curve | Notes |
| --- | --- | --- |
| Enter (appear, slide in) | `--ease-out-expo` | Near-equivalent to Emil's `cubic-bezier(0.23,1,0.32,1)`. |
| Exit (dismiss, slide out) | `--ease-out-expo` | Same curve, ~75% of entrance duration. |
| Move / resize in view | `--ease-in-out-quad` | Balanced, ambient. |
| Hover, color, opacity | `--ease-standard` | The token's default ease. |
| Emphasis (one per page) | `--ease-spring` | Overshoot. Use sparingly. |
| Drawer / bottom sheet | `--ease-out-drawer` | Soft deceleration. |
| Dramatic in-out | `--ease-in-out-strong` | Pin, hold, release. |
| Uniform / progress | `linear` | Only for timed progress or hold-to-confirm. |
| Unsure | `--ease-out-expo` | When in doubt, ease out. |

Never linear for organic motion, never bounce/elastic on UI.

### Duration ladder

| Duration | Use | Element examples |
| --- | --- | --- |
| 80–100ms | instant feedback | toggle snap, checkbox fill (below ~80ms a transition is imperceptible, so button `:active` skips it entirely) |
| 100–160ms | fast feedback | press scale, color shift, icon swap |
| 125–200ms | tooltip, small state | tooltip, badge, chip |
| 150–250ms | dropdown, menu | select menu, popover, tab panel |
| 200–350ms | modal, drawer | dialog, slide-over, nav drawer |
| 300–500ms | layout shift | accordion, view transition, reorder |
| 500–800ms | entrance sequence | load stagger, hero reveal (L3 only) |

**UI motion stays under 300ms unless you can name the reason it needs
longer.** Entrances (500-800ms) are the named exception for L3 hero moments.

Exits run ~75% of the matching entrance duration — leaving is quicker than
arriving. open-design's enter-200ms/exit-140ms pair is exactly this ratio and
works well for mid-tier elements.

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

**Keep `blur()` under 20px.** Larger radii are expensive to composite and
read as a rendering glitch rather than a material. 4-12px is the sweet spot
for depth-of-field effects.

**Use `translateY(100%)` for self-height sliding.** When an element's own
height is the travel distance (bottom sheet, notification toast), percentage
translate references the element's own box, so no JS measurement needed and
it stays correct as content resizes.

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
