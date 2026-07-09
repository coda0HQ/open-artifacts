# Canvas mode (--canvas)

Read this only when building with `--canvas`. Canvas is **orthogonal to
`--level`**: `--level` still sets fidelity and motion budget; `--canvas` swaps
the *shell* — an infinite spatial plane of pan/zoom **frames** instead of a
scrolling document. The two compose:

- `--level 1 --canvas` — spatial notes / a board. Few frames, typographic,
  the focus zoom is the only motion.
- `--level 2 --canvas` — the default. A multi-frame prototype or flow; frames
  are real, operable screens once focused; connectors show flow.
- `--level 3 --canvas` — canvas-as-showcase. The composition is the hero and the
  overview → focus zoom is the one orchestrated moment. Keep per-frame motion
  quiet (see the canvas budget note in `motion.md`).

The runtime below is **vendored**: paste the CSS into a leading `<style>` (after
the token contract from `references/tokens.css` and your direction overrides) and
the JS into a trailing `<script>`. Native browser APIs only — no libraries, no
external requests (the strict CSP blocks them anyway). All viewer state lives in
memory; the sandbox is opaque-origin, so `localStorage`/`sessionStorage` throw.

## Tunable constants

`MIN`/`MAX` (0.1–4× zoom), `PAD` (fit padding, 64 screen px), dot spacing
(24 world px), the wheel-zoom divisor (`/200`), and the 400 ms tween — a camera
fit reads better slightly longer than `--motion-base`. Override any of them for
a specific composition, but name why.

## The shell: three hard constraints

1. **One transformed plane.** All spatial content lives inside `.oa-plane`; pan
   and zoom are `transform: translate() scale()` on that single element. Never
   animate `top`/`left`/`width`/`height` — they repaint the whole plane where a
   transform composites on the GPU.
2. **The zoom cluster is `position: fixed`, never `sticky`.** The viewer's
   `LAYOUT_SCRIPT` walks every body descendant and rewrites the `top` of any
   `position: sticky` element to `var(--oa-header-h)`, which would shove a sticky
   cluster down under the service header. `fixed`/`absolute` are untouched.
3. **Size the viewport to `calc(100dvh - var(--oa-header-h, 2.5rem))`.** The
   in-flow sticky header sits above; the viewport owns its own
   `overflow: hidden`, so the body never scrolls and fights the pan.

## The vendored runtime — CSS

```css
/* Viewport. Sized to the visible area below the service header.
   padding/border MUST stay 0: background-origin is padding-box, so any inset
   would shift the dot lattice out of step with the plane's transform. */
.oa-canvas {
  position: relative;
  height: calc(100dvh - var(--oa-header-h, 2.5rem));
  padding: 0;
  border: 0;
  overflow: hidden;
  touch-action: none;
  overscroll-behavior: contain;
  cursor: grab;
  background-color: var(--bg);
  /* Dot grid lives on the viewport, not the plane, so its spacing tracks
     zoom while its origin tracks pan. --dot-o is written by paint(). */
  background-image: radial-gradient(circle at 1px 1px,
    color-mix(in oklab, var(--muted) calc(var(--dot-o, 1) * 42%), transparent) 1px,
    transparent 0);
  background-size: calc(24px * var(--k, 1)) calc(24px * var(--k, 1));
  background-position: var(--tx, 0px) var(--ty, 0px);
}
.oa-canvas[data-panning] { cursor: grabbing; }

/* One transformed element. Never animate top/left/width/height.
   will-change only while a gesture is live: a permanent hint promotes the
   whole plane to its own layer for the life of the page. */
.oa-plane {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  transform: translate(var(--tx, 0px), var(--ty, 0px)) scale(var(--k, 1));
}
.oa-canvas[data-panning] .oa-plane { will-change: transform; }

/* Frames are placed in world coordinates via --x/--y/--w/--h (unitless px).
   The label is absolutely positioned ABOVE the frame, so --x/--y/--w/--h
   describe the body exactly — otherwise the label's height would offset
   every fitTo() by a scaled ~20px. */
.oa-frame {
  position: absolute;
  left: calc(var(--x) * 1px);
  top: calc(var(--y) * 1px);
  width: calc(var(--w) * 1px);
}
.oa-frame-label {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin: 0 0 var(--space-2);
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--muted);
  text-align: left;
  cursor: pointer;
  /* Counter-scale so labels stay legible at any zoom, as in Figma. Capped at
     3x: an uncapped 1/k balloons the label past its frame when zoomed far out.
     Origin is the anchored corner (bottom:100%; left:0) or the label drifts. */
  transform: scale(min(calc(1 / var(--k, 1)), 3));
  transform-origin: 0 100%;
}
.oa-frame-label:focus-visible { box-shadow: var(--focus-ring); border-radius: var(--radius-sm); }
.oa-frame-body {
  height: calc(var(--h) * 1px);
  overflow: hidden;
  background: var(--bg);
  border-radius: var(--radius-lg);
  box-shadow: var(--elev-ring);
}
.oa-frame[data-focused] .oa-frame-body { box-shadow: 0 0 0 2px var(--accent); }

/* Freeform layer: notes and connectors share the plane's world coordinates. */
.oa-note {
  position: absolute;
  left: calc(var(--x) * 1px);
  top: calc(var(--y) * 1px);
  max-width: 22ch;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  box-shadow: var(--elev-ring);
  font-size: var(--text-sm);
}
.oa-connectors {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.oa-connectors path { fill: none; stroke: var(--border); stroke-width: 1.5; }

/* fixed, NOT sticky: LAYOUT_SCRIPT rewrites the `top` of every sticky element
   in the body. z-index stays under the service header. */
.oa-zoom {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--surface);
  border-radius: var(--radius-pill);
  box-shadow: var(--elev-ring), var(--elev-raised);
}
.oa-zoom button {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--fg);
  font: inherit;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}
.oa-zoom button:hover { background: var(--surface-2); }
.oa-zoom button:focus-visible { box-shadow: var(--focus-ring); }
.oa-zoom output {
  min-width: 5ch;
  text-align: center;
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* Usability of a pan/zoom plane tracks viewport WIDTH, not input type: a
   touchscreen laptop drives a canvas fine, a narrow mouse-driven window does
   not. Below 640px the plane linearizes into a scrolling stack rather than
   shipping a pinch handler that fights native scroll. */
@media (max-width: 640px) {
  .oa-canvas { height: auto; overflow: visible; touch-action: auto; cursor: auto; background-image: none; }
  .oa-plane { position: static; transform: none; display: flex; flex-direction: column; gap: var(--space-8); padding: var(--space-4); }
  .oa-frame { position: static; width: 100%; }
  .oa-frame-label { position: static; transform: none; margin-bottom: var(--space-2); }
  .oa-frame-body { height: auto; min-height: 60vh; }
  .oa-note { position: static; max-width: 100%; }
  .oa-zoom, .oa-connectors { display: none; }
}
```

## The vendored runtime — JS

```js
(function () {
  const canvas = document.getElementById("canvas");
  const pct = document.getElementById("zoom-pct");
  const frames = [...canvas.querySelectorAll(".oa-frame")];
  if (!frames.length) return;

  const MIN = 0.1;
  const MAX = 4;
  const PAD = 64;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // Matches the CSS breakpoint. Below it the plane is a stacked document read,
  // so every handler bails and the transform is cleared.
  const compact = matchMedia("(max-width: 640px)");
  const view = { x: 0, y: 0, k: 1 };
  let raf = 0;
  let focused = null;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const box = (f) => ({
    x: +f.style.getPropertyValue("--x"),
    y: +f.style.getPropertyValue("--y"),
    w: +f.style.getPropertyValue("--w"),
    h: +f.style.getPropertyValue("--h"),
  });

  function paint() {
    const s = canvas.style;
    s.setProperty("--tx", `${view.x}px`);
    s.setProperty("--ty", `${view.y}px`);
    s.setProperty("--k", view.k);
    s.setProperty("--dot-o", clamp((view.k - 0.3) * 1.8, 0, 1));
    pct.value = `${Math.round(view.k * 100)}%`;
  }

  function tweenTo(to, ms) {
    cancelAnimationFrame(raf);
    if (reduced.matches || !ms) {
      Object.assign(view, to);
      paint();
      return;
    }
    const from = { ...view };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - p) ** 4;
      view.x = from.x + (to.x - from.x) * e;
      view.y = from.y + (to.y - from.y) * e;
      view.k = from.k + (to.k - from.k) * e;
      paint();
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // Scale about a viewport point so the world point under it stays pinned.
  // Derived from screen = world * k + t, solved for the new t. `r` uses the
  // CLAMPED k, so the pin holds even when the zoom saturates at MIN/MAX.
  function zoomAt(factor, cx, cy) {
    const k = clamp(view.k * factor, MIN, MAX);
    const r = k / view.k;
    view.x = cx - (cx - view.x) * r;
    view.y = cy - (cy - view.y) * r;
    view.k = k;
    paint();
  }

  function centerZoom(factor) {
    zoomAt(factor, canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  function pan(dx, dy) {
    view.x += dx;
    view.y += dy;
    paint();
  }

  function fitTo(b, ms) {
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const k = clamp(Math.min((vw - PAD * 2) / b.w, (vh - PAD * 2) / b.h), MIN, MAX);
    tweenTo({ k, x: (vw - b.w * k) / 2 - b.x * k, y: (vh - b.h * k) / 2 - b.y * k }, ms);
  }

  function bounds() {
    const bs = frames.map(box);
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    return {
      x,
      y,
      w: Math.max(...bs.map((b) => b.x + b.w)) - x,
      h: Math.max(...bs.map((b) => b.y + b.h)) - y,
    };
  }

  // `inert` (not pointer-events) gates an unfocused frame: it takes the body
  // out of BOTH hit-testing and the tab order, so Tab never lands inside a
  // frame the viewer has not opened, and a click on it retargets to the
  // wrapper — which is what click-to-focus needs. Assigning `inert` across
  // every body re-inerts the OUTGOING frame, so tabbing A -> B never leaves
  // two live bodies. `inert` belongs on the body, never the .oa-frame wrapper.
  function focus(frame) {
    if (compact.matches) return;
    focused?.removeAttribute("data-focused");
    focused = frame;
    for (const f of frames) {
      f.querySelector(".oa-frame-body").inert = f !== frame;
    }
    if (!frame) {
      fitTo(bounds(), 400);
      return;
    }
    frame.setAttribute("data-focused", "");
    fitTo(box(frame), 400);
  }

  // One delegated click covers both paths: the label button and an inert body
  // both resolve to their .oa-frame wrapper via closest(). A click on the
  // background (or the focused frame, whose body is live and handles its own
  // clicks) returns to the overview.
  canvas.addEventListener("click", (e) => {
    if (compact.matches || clickSuppressed || e.target.closest(".oa-zoom")) return;
    const frame = e.target.closest(".oa-frame");
    if (frame && frame !== focused) focus(frame);
    else if (!frame) focus(null);
  });

  // Tabbing to a label focuses its frame, so keyboard navigation mirrors the
  // click behavior without a second listener.
  for (const frame of frames) {
    frame.querySelector(".oa-frame-label").addEventListener("focus", () => {
      if (frame !== focused) focus(frame);
    });
  }

  // passive:false or preventDefault() is ignored and the page scrolls away.
  canvas.addEventListener("wheel", (e) => {
    if (compact.matches) return;
    e.preventDefault();
    // deltaMode 1 = lines (a real mouse wheel in Firefox), 2 = pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const r = canvas.getBoundingClientRect();
    // Trackpad pinch and Cmd/Ctrl+wheel both arrive as ctrlKey; a bare
    // wheel/two-finger swipe pans.
    if (e.ctrlKey) {
      zoomAt(Math.exp(-dy / 200), e.clientX - r.left, e.clientY - r.top);
    } else {
      view.x -= dx;
      view.y -= dy;
      paint();
    }
  }, { passive: false });

  let drag = null;
  let space = false;
  let clickSuppressed = false;
  canvas.addEventListener("pointerdown", (e) => {
    if (compact.matches || e.button !== 0 || e.target.closest(".oa-zoom")) return;
    clickSuppressed = false;
    // Without space held, a press inside a frame belongs to the frame: it is
    // either a click-to-focus or, once focused, the frame's own UI. Space-drag
    // pans from anywhere.
    if (!space && e.target.closest(".oa-frame")) return;
    drag = { px: e.clientX, py: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
    canvas.setAttribute("data-panning", "");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.px = e.clientX;
    drag.py = e.clientY;
    view.x += dx;
    view.y += dy;
    paint();
  });
  // A drag that crossed the threshold must not also fire a click (which would
  // focus whatever frame the pan happened to end over). Read by the click
  // handler above, which runs after pointerup.
  function endDrag(e) {
    if (!drag) return;
    clickSuppressed = drag.moved > 6 || space;
    drag = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.removeAttribute("data-panning");
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  addEventListener("keydown", (e) => {
    if (compact.matches) return;
    // Let the focused frame's own inputs keep their keystrokes.
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.code === "Space") space = true;
    else if (e.key === "0" || e.key.toLowerCase() === "f") focus(null);
    // Zoom to 100% about the viewport center. Setting k alone would scale
    // about the plane origin and fling the composition off-screen.
    else if (e.key === "1") centerZoom(1 / view.k);
    else if (e.key === "Escape") focus(null);
    else if (e.key === "+" || e.key === "=") centerZoom(1.2);
    else if (e.key === "-") centerZoom(1 / 1.2);
    else if (e.key === "ArrowLeft") pan(60, 0);
    else if (e.key === "ArrowRight") pan(-60, 0);
    else if (e.key === "ArrowUp") pan(0, 60);
    else if (e.key === "ArrowDown") pan(0, -60);
    else return;
    e.preventDefault();
  });
  addEventListener("keyup", (e) => { if (e.code === "Space") space = false; });

  document.getElementById("zoom-in").addEventListener("click", () => centerZoom(1.2));
  document.getElementById("zoom-out").addEventListener("click", () => centerZoom(1 / 1.2));
  document.getElementById("zoom-fit").addEventListener("click", () => focus(null));

  // Crossing the breakpoint in either direction re-establishes the right mode:
  // stacked read clears the transform and un-inerts every body so the document
  // stays operable; canvas re-fits. The static `inert` in the markup means the
  // stacked read is correct on a first paint that never runs the canvas path.
  function init() {
    if (compact.matches) {
      cancelAnimationFrame(raf);
      canvas.removeAttribute("style");
      focused?.removeAttribute("data-focused");
      focused = null;
      for (const f of frames) f.querySelector(".oa-frame-body").inert = false;
      return;
    }
    focus(null);
    fitTo(bounds(), 0);
  }
  compact.addEventListener("change", init);
  addEventListener("resize", () => { if (!compact.matches && !focused) fitTo(bounds(), 0); });
  init();
})();
```

## Markup shape

Frames carry world coordinates as inline custom properties. `--x/--y/--w/--h`
are unitless pixel numbers describing the **body**.

```html
<div class="oa-canvas" id="canvas" role="group"
     aria-label="Canvas. Drag to pan, ctrl-scroll to zoom, click a frame to focus.">
  <div class="oa-plane" id="plane">
    <!-- connectors: one inline SVG in world coords, behind the frames -->
    <svg class="oa-connectors" aria-hidden="true"><path d="M ..."/></svg>

    <section class="oa-frame" style="--x:0;--y:0;--w:390;--h:844">
      <button class="oa-frame-label" type="button">Login</button>
      <div class="oa-frame-body" inert><!-- real, operable UI --></div>
    </section>

    <p class="oa-note" style="--x:150;--y:920">Cold-start empty state still open.</p>
  </div>
</div>
<div class="oa-zoom" role="group" aria-label="Zoom controls">
  <button id="zoom-out" type="button" aria-label="Zoom out">&minus;</button>
  <output id="zoom-pct">100%</output>
  <button id="zoom-in" type="button" aria-label="Zoom in">+</button>
  <button id="zoom-fit" type="button" aria-label="Fit all to view">⤢</button>
</div>
```

## The frame contract

Frames are first-class: a real `<section>`, a `<button>` label that is the
keyboard entry point, a bounded body. Size to real device or slide dimensions
(390×844, 1440×900, 1600×900). Gutter ≥ 120 world px so counter-scaled labels
never collide at low zoom. Lay frames out with intent — a row is a flow, a grid
is a set of variants — not scattered across empty pixels.

Unfocused frame bodies carry `inert`, which removes them from hit-testing *and*
the tab order in one move. `pointer-events: none` would do neither job: it
leaves controls tabbable while mouse-dead, and it lets a click fall through to
the viewport so `closest(".oa-frame")` returns `null` and the frame can never be
focused by clicking it. Put `inert` on `.oa-frame-body` only — on the wrapper it
kills click-to-focus for the same reason.

A frame holds a bounded screen/slide/variant. Build the UI for real, with real
states — the "no fake screenshots" ban in `design.md` explicitly exempts the case
where the artifact *is* the prototype, and a canvas of frames is that case.

## The freeform contract

Between frames: sticky notes (`.oa-note`, `--accent-soft` + one `--elev-ring`),
annotations, connector lines (one inline `<svg class="oa-connectors">` in world
coordinates, `stroke: var(--border)`, accent only to mark the primary path), and
a legend (a `.oa-note`). Freeform elements take `--x`/`--y` but no label and no
focus behavior. A connector must encode a real relation — never decorative
spaghetti.

## Accessibility

Frame labels are real buttons, so tab order walks the frames in **DOM order,
which must match reading order, not spatial order**. Activating a label focuses
its frame and un-`inert`s its body, so the next Tab enters the frame's own
controls. `Escape`, `0`, `F`, and the fit button all return to the overview;
`1` = 100%; `+`/`-` zoom about the viewport center; arrows pan. The keydown
handler bails when the target is an `input`/`textarea`/`select`/`contenteditable`,
so a focused frame's form keeps its keystrokes.

Every tween checks `prefers-reduced-motion` and jumps instantly. Frame labels
counter-scale by `1/k` (capped at 3×) so they stay legible at any zoom.
Zoom-cluster buttons are 44px.

**The mobile story.** Below 640px the plane linearizes into a scrolling stack
of full-width frames; the grid, connectors, and zoom cluster hide, and every
handler bails. The gate is viewport **width**, not `(pointer: coarse)` — a
touchscreen laptop drives a canvas fine, while a narrow mouse-driven window
cannot, so input type is the wrong signal. Crossing the breakpoint live re-runs
`init()` in both directions. State the honest limitation: **multi-touch pinch is
not implemented.** Trackpad pinch works because browsers deliver it as `wheel` +
`ctrlKey`; a touch tablet above 640px pans by drag and zooms with the cluster
buttons. `touch-action: none` is required for drag-pan to work at all, and it
suppresses native pinch — faking a worse pinch than the browser's is not a trade
worth making.

## Bans

- No fake editor chrome — toolbars, layer panels, tab bars, named cursors, auto
  "Frame 12" labels. The canvas is content, not a pretend Figma.
- No minimap for fewer than ~8 frames.
- No parallax between plane layers.
- No connector spaghetti — every line is a real relation; no rats-nest
  crossings.
- The dot grid stays `var(--border)` and fades; not high-contrast graph paper.
- No row of identical device mockups (the identical-card-grid trope, spatial
  form).
- No infinite plane holding one frame — that is a document, so drop `--canvas`.

## Ship gate — canvas addendum

Run the `design.md` ship gate, plus:

- [ ] Overview (`0`/`F`) frames the whole composition with padding; nothing
      clipped at the edges.
- [ ] Every frame reachable + readable when focused; labels are real names.
- [ ] Zoom cluster is `position: fixed` (not sticky), visible in both themes,
      buttons have hover + focus-visible.
- [ ] Pan (drag + space-drag), wheel-pan, ctrl/pinch zoom, and keyboard
      (`0`/`F`/`1`/`+`/`-`/arrows/Esc) all work; focus zoom respects
      reduced-motion (instant).
- [ ] A drag that starts on a frame pans rather than clicking through; focus +
      `Escape` round-trips.
- [ ] 640px degrades to the stacked read; content fully reachable, no pinch
      required, zoom cluster hidden.
- [ ] In-memory state only (no `localStorage`); no external requests.
