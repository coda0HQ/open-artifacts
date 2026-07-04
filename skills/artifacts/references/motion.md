# Motion patterns (Level 3)

Level 3 artifacts use **native browser APIs only** — no Framer Motion, no
GSAP, no CDN scripts. The strict CSP (`script-src 'unsafe-inline';
default-src 'none'`) blocks all external requests, so every animation is
inline CSS + vanilla JS. This is the project's differentiator: library-free
motion that feels designed, not templated.

Read this only when building at `--level 3`. Respect `prefers-reduced-motion`
at every level — wrap motion in a `@media (prefers-reduced-motion: no-preference)`
guard so reduced-motion users get the static version.

## Easing

Spring-like motion without a physics library. These cubic-beziers cover 90%
of cases:

```css
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);   /* overshoot, lively */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);      /* settle, premium */
--ease-in-out-quad: cubic-bezier(0.45, 0, 0.55, 1);  /* balanced */
```

Use `--ease-out-expo` for entrances (things arriving), `--ease-spring` for
emphasis (one or two moments per page, not everywhere). Never linear for
organic motion.

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
loading screen, not an entrance.

## Scroll-triggered reveals

`IntersectionObserver` + a class toggle. No scroll listeners, no jank.

```js
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
```

**Reveals must enhance an already-visible default.** Transitions pause on
hidden tabs and in headless renderers — and artifacts get rendered in exactly
those contexts — so an `opacity: 0` that only clears on `.in` can ship the
section blank. Set the initial hidden state behind a JS-added class (add `.js`
to `<html>` as the first thing your script does) or inside
`@media (prefers-reduced-motion: no-preference)`, so the static default is full
visibility.

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
.glow { animation: breathe 8s var(--ease-in-out-quad) infinite; }
```

## Anti-patterns

- Animating `top`/`left`/`margin` — use `transform` and `opacity` only.
- `linear` easing for organic motion.
- Stagger cascades longer than 6 items or 800ms.
- Scroll-triggered theatre on a document (that's L3 for a landing page, not
  for an API reference).
- More than one ambient loop at a time.
- Motion that hides content from reduced-motion users — always provide the
  static endpoint.

## Budget

A Level 3 page should have **one orchestrated moment** (the load sequence or
a scroll-driven hero) and **quiet everything else**. Spend your boldness in
one place; ornament elsewhere reads as AI-slop.
