# Canvas mode

> Sources: Apple WWDC 2018 *Designing Fluid Interfaces* (gesture physics).
> See root README credits.

Read this only when the Recipe uses `artifact.canvas: true`. The canvas shell
is **fluid**:
momentum scrolling, pinch-to-zoom, rubber-band edge resistance, an optional
guided tour, connector-aware spotlight highlighting, and `#frame-id` deep
links. Canvas is **orthogonal to level**: `artifact.level` still sets fidelity
and motion budget; Canvas swaps the *shell* for an infinite spatial plane
of pan/zoom **frames** instead of a scrolling document. The two compose:

- Level 1 Canvas — spatial notes / a board. Few frames, typographic,
  the focus zoom is the only motion.
- Level 2 Canvas — the default. A multi-frame prototype or flow; frames
  are real, operable screens once focused; connectors show flow.
- Level 3 Canvas — canvas-as-showcase. The composition is the hero and the
  overview → focus zoom is the one orchestrated moment. Keep per-frame motion
  quiet (see the canvas budget note in `motion.md`).

The runtime below is **vendored and builder-owned**. The Recipe builder extracts
the CSS and JS fenced sections, injects them after tokens/authored styles and
scripts, and adds zoom plus optional tour controls. Do not copy the runtime or
controls into fragments. Author only `#canvas`, `#plane`, frames, notes,
connectors, and content. Native browser APIs only; all viewer state lives in
memory.

## Tunable constants

`MIN`/`MAX` (0.1-4x zoom), `PAD` (fit padding, 48 screen px), dot spacing
(24 world px), the wheel-zoom divisor (`/200`), and the 400 ms tween -- a camera
fit reads better slightly longer than `--motion-base`.

Physics constants (fluid interactions):
- `FRICTION` (0.998 per ms) -- momentum decay rate for flick-to-glide.
- `RUBBER` (0.55) -- Apple rubber-band coefficient for over-scroll resistance.
- `FLICK` (0.11 px/ms) -- minimum release velocity to trigger glide.
- `VEL_WIN` (100 ms) -- sampling window for velocity estimation.
- `TAP_SLOP` (6 css-px) -- press+release under this is a tap; past it is a pan.
  Resumed pinches start at `TAP_SLOP + 1` so a pinch lift is never a tap.

Visual constants:
- `SPOT_DIM` -- `{ frame: 0.4, path: 0.15 }`; written to `--spot-dim-frame` /
  `--spot-dim-path` on the canvas so CSS and JS share one source.
- `CHIP_K` (0.5) -- the zoom threshold where notes collapse to chips.

Tour attribute: `data-tour="n"` on frames, sequential integer starting at 1.

These constants live inside the vendored runtime IIFE the builder injects;
they are **not overridable** from a fragment (there is no config hook, and
copying the runtime into a fragment is forbidden). The defaults are tuned for
the common case; if a composition genuinely needs different physics, that is a
runtime change, not an authoring one — raise it as a runtime issue rather than
working around it in markup.

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
  /* Every drag on the surface pans (see pointerdown), frame text included,
     so this is a pan surface, not a document: suppress native text selection
     or a drag smears a selection across labels and frame text. inert and
     pointer capture don't prevent that in every engine (Safari selects
     regardless), and a stray selection-drag also swallows the tap that
     focuses a frame. Selection returns where it can't fight a pan: form
     fields below, and the compact stacked read. */
  user-select: none;
  -webkit-user-select: none;
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
.oa-frame-label::before {
  content: "";
  position: absolute;
  top: -12px;
  bottom: -12px;
  left: 50%;
  width: max(100%, 44px);
  transform: translateX(-50%);
}
.oa-frame-label:active { transform: scale(min(calc(1 / var(--k, 1)), 3)) translateY(1px); }
.oa-frame-label:focus-visible { box-shadow: var(--focus-ring); border-radius: var(--radius-sm); }
.oa-frame-body {
  height: calc(var(--h) * 1px);
  overflow: hidden;
  background: var(--bg);
  border-radius: var(--radius-lg);
  /* Inset ring: the 1px hairline draws INSIDE the body's border-box so it
     never bleeds into a 0-gap neighbor (the outward --elev-ring token is
     still used by .oa-note and labels, which float in the plane and need
     the outward edge). The focused-frame accent ring below stays outset. */
  box-shadow: inset 0 0 0 1px var(--border);
  /* padding strictly exceeds border-radius (16) so a flush child's outset
     selection/focus border clears the rounded clip corner — overflow:hidden
     + border-radius otherwise cut a full-width child's border at the curve.
     Full-bleed frames override with `padding: 0` and must use INSET
     selection rings (see the frame contract) since they have no clearance. */
  padding: var(--space-5);
}
/* Inset direct children of the body horizontally so a full-width descendant
   (a selected row's accent-soft fill, a hairline divider) clears the rounded
   clip curve at every zoom. The body's own padding (20 world) minus the
   radius (16) leaves only 4 world px of clearance — sub-pixel at overview
   zoom (0.4 screen px at MIN k=0.1), and an author's scroll-container child
   may itself render with 0 padding (e.g. when its --space-* tokens are
   undefined), placing its full-width descendants flush to the content-box
   edge. This 8 world-px side margin makes the clearance 12 world px (>=1
   screen px at MIN zoom) unconditionally. width is reset so the margin does
   not overflow the content box. An author who needs a genuinely full-bleed
   direct child (edge-to-edge media) sets `margin-inline: 0` on that child. */
.oa-frame-body > * {
  margin-inline: var(--space-2);
  width: auto;
}
.oa-frame[data-focused] .oa-frame-body { box-shadow: 0 0 0 2px var(--accent); }
/* Drag = pan even inside a focused frame (the Figma model), so flowing text
   is never drag-selectable. Editable fields are the exception: they own their
   pointer (see CONTROLS in the runtime JS) and caret work needs selection.
   Exclude contenteditable="false" — locked blocks stay pan surface. */
.oa-frame[data-focused] .oa-frame-body :is(input, textarea, select, [contenteditable]:not([contenteditable="false"])) {
  user-select: text;
  -webkit-user-select: text;
}

/* Freeform layer: notes and connectors share the plane's world coordinates.
   Counter-scaled like frame labels, or a note's fixed max-width collapses to
   a thin sliver at low overview zoom (the single most common canvas bug). */
.oa-note {
  position: absolute;
  left: calc(var(--x) * 1px);
  top: calc(var(--y) * 1px);
  box-sizing: border-box;
  /* `width: max-content` is load-bearing. The note is absolutely positioned, so
     without an explicit width it shrink-to-fits. When its text holds an inline
     `.fr-mono` span whose run is full of hyphens (`--level 2 --canvas`), the
     available-width solver can pick the *minimum* preferred width and let
     `overflow-wrap: anywhere` stack every glyph one per line — the note turns
     into a tall thin strip. max-content forces the natural single-line width,
     capped by `max-width: 28ch`. The collapsed-chip rule below overrides this
     with `width: 32px`. */
  width: max-content;
  max-width: 28ch;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--accent-soft);
  color: var(--fg);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-ring);
  font-size: var(--text-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
  transform: scale(min(calc(1 / var(--k, 1)), 3));
  transform-origin: 0 0;
}
/* At overview zoom a counter-scaled note balloons to ~3x and clutters the
   plane. paint() collapses it to a small pill chip; clicking (or Enter /
   Space on the focused chip) pins it open until zoom crosses back over the
   threshold. data-open gates the collapsed styles, so a pinned note shows
   its full text even while collapsed-by-zoom.
   Collapsed/pinned notes counter-scale FULLY (no 3x cap) and CENTER on
   their --x/--y anchor: they are screen-space UI like a Figma comment pin —
   constant on-screen size at any zoom, pinned by their center so they never
   creep down-right into neighboring frames. translate comes AFTER scale in
   the list so the -50% offset resolves in screen pixels, not world pixels. */
.oa-note[data-collapsed="true"] {
  transform: scale(calc(1 / var(--k, 1))) translate(-50%, -50%);
  user-select: none;
  -webkit-user-select: none;
  z-index: 1;
}
/* Pinned open while collapsed-by-zoom: a floating popover over the plane.
   Solid surface (the translucent accent tint reads muddy over frames),
   raised shadow, above neighboring chips. Width is `max-content` (from the
   base rule) so the popover keeps its rectangular shape, not the 32px chip;
   cap height against the viewport and scroll if a note is unusually long. */
.oa-note[data-collapsed="true"][data-open="true"] {
  max-height: calc(80dvh - var(--oa-header-h, 2.5rem));
  overflow-y: auto;
  background: var(--surface);
  box-shadow: var(--elev-ring), var(--elev-raised);
  z-index: 2;
  cursor: pointer;
}
.oa-note[data-collapsed="true"]:not([data-open="true"]) {
  max-width: none;
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: var(--radius-pill);
  background: var(--surface);
  box-shadow: var(--elev-ring), var(--elev-raised);
  font-size: 0;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
    box-shadow var(--motion-fast) var(--ease-standard);
}
.oa-note[data-collapsed="true"]:not([data-open="true"])::before {
  content: "";
  position: absolute;
  inset: -6px;
}
/* rem-sized children (e.g. an inline .fr-mono span) ignore the parent's
   font-size: 0 — zero every descendant or their text leaks out of the chip. */
.oa-note[data-collapsed="true"]:not([data-open="true"]) * { font-size: 0; }
.oa-note[data-collapsed="true"]:not([data-open="true"])::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 14px;
  height: 14px;
  background: var(--accent);
  transform: translate(-50%, -50%);
  /* Remix ri-edit, vendored from references/icons.md, as a data-URI mask so
     the glyph inherits --accent in both themes (content:url() SVGs cannot be
     recolored). */
  mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6.41421 15.89L16.5563 5.74785L15.1421 4.33363L5 14.4758V15.89H6.41421ZM7.24264 17.89H3V13.6473L14.435 2.21231C14.8256 1.82179 15.4587 1.82179 15.8492 2.21231L18.6777 5.04074C19.0682 5.43126 19.0682 6.06443 18.6777 6.45495L7.24264 17.89ZM3 19.89H21V21.89H3V19.89Z"/></svg>') center / contain no-repeat;
  -webkit-mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6.41421 15.89L16.5563 5.74785L15.1421 4.33363L5 14.4758V15.89H6.41421ZM7.24264 17.89H3V13.6473L14.435 2.21231C14.8256 1.82179 15.4587 1.82179 15.8492 2.21231L18.6777 5.04074C19.0682 5.43126 19.0682 6.06443 18.6777 6.45495L7.24264 17.89ZM3 19.89H21V21.89H3V19.89Z"/></svg>') center / contain no-repeat;
}
.oa-note:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring), var(--elev-ring), var(--elev-raised);
}
.oa-connectors {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  /* vector-effect keeps strokes one screen-px regardless of the plane's
     scale, so a 1.5px connector stays 1.5px at k=0.25 instead of vanishing
     to 0.375px. Without it, connectors disappear at overview zoom. */
}
.oa-connectors path {
  fill: none;
  stroke: var(--border);
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

/* fixed, NOT sticky: LAYOUT_SCRIPT rewrites the `top` of every sticky element
   in the body. z-index stays under the service header. Buttons carry vendored
   Remix glyphs (ri-subtract / ri-add / ri-fullscreen-exit) as data-URI masks
   on ::after — the button text stays for accessibility but renders at size 0,
   so screen readers announce it while the glyph inherits --fg/--accent. */
.oa-zoom {
  position: fixed;
  right: max(var(--space-4), env(safe-area-inset-right));
  bottom: max(var(--space-4), env(safe-area-inset-bottom));
  z-index: 10;
  display: flex;
  align-items: center;
  padding: var(--space-1);
  background: color-mix(in oklab, var(--surface), transparent 8%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-radius: var(--radius-pill);
  box-shadow: var(--elev-ring), var(--elev-raised);
}
.oa-zoom button {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0;
  line-height: 1;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.oa-zoom button::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 15px;
  height: 15px;
  background: currentColor;
  transform: translate(-50%, -50%);
  mask: var(--icon) center / contain no-repeat;
  -webkit-mask: var(--icon) center / contain no-repeat;
}
#zoom-out { --icon: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M5 11V13H19V11H5Z"/></svg>'); }
#zoom-in { --icon: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11 11V5H13V11H19V13H13V19H11V13H5V11H11Z"/></svg>'); }
#zoom-fit { --icon: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M18 7H22V9H16V3H18V7ZM8 9H2V7H6V3H8V9ZM18 17V21H16V15H22V17H18ZM8 15V21H6V17H2V15H8Z"/></svg>'); }
/* Gate :hover behind fine-pointer so a touch tablet above 640px (which the
   canvas supports for cluster-button zoom) cannot get a sticky hover state it
   cannot dismiss. */
@media (hover: hover) and (pointer: fine) {
  .oa-zoom button:hover { background: var(--surface-2); color: var(--fg); }
  .oa-note[data-collapsed="true"]:not([data-open="true"]):hover {
    background: var(--accent-soft);
  }
}
.oa-note[data-collapsed="true"]:not([data-open="true"]):active {
  background: var(--accent-soft);
  /* Preserve chip centering; nudge 1px in screen space after scale. */
  transform: scale(calc(1 / var(--k, 1))) translate(-50%, calc(-50% + 1px));
}
.oa-zoom button:active {
  background: var(--surface-2);
  color: var(--fg);
  transform: translateY(1px);
}
.oa-zoom button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
/* The readout doubles as the fit affordance's neighbor — hairline separators
   carve the pill into zones without boxing every control. */
.oa-zoom output {
  box-sizing: border-box;
  display: grid;
  place-items: center;
  min-width: 6ch;
  height: 44px;
  padding: 0 var(--space-2);
  text-align: center;
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.oa-zoom #zoom-fit {
  position: relative;
  margin-left: var(--space-2);
}
.oa-zoom #zoom-fit::before {
  content: "";
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: -5px;
  width: 1px;
  background: var(--border);
}

/* --- Spotlight: dims non-related elements when hovering/focusing a frame.
   Opacities come from --spot-dim-* set by the runtime (SPOT_DIM). --- */
.oa-plane[data-spotlight] .oa-frame:not([data-lit]),
.oa-plane[data-spotlight] .oa-note:not([data-lit]) {
  opacity: var(--spot-dim-frame, 0.4);
  transition: opacity 150ms var(--ease-standard);
}
.oa-plane[data-spotlight] .oa-connectors path:not([data-lit]) {
  opacity: var(--spot-dim-path, 0.15);
  transition: opacity 150ms var(--ease-standard);
}
.oa-plane[data-spotlight] .oa-connectors path[data-lit] {
  stroke: var(--accent);
  transition: stroke 150ms var(--ease-standard);
}
.oa-plane:not([data-spotlight]) .oa-frame,
.oa-plane:not([data-spotlight]) .oa-note,
.oa-plane:not([data-spotlight]) .oa-connectors path {
  transition: opacity 150ms var(--ease-standard);
}
@media (prefers-reduced-motion: reduce) {
  .oa-plane[data-spotlight] .oa-frame,
  .oa-plane[data-spotlight] .oa-note,
  .oa-plane[data-spotlight] .oa-connectors path,
  .oa-plane:not([data-spotlight]) .oa-frame,
  .oa-plane:not([data-spotlight]) .oa-note,
  .oa-plane:not([data-spotlight]) .oa-connectors path {
    transition: none;
  }
}

/* --- Tour controls: prev/next + progress, docked to the zoom cluster --- */
.oa-tour {
  display: flex;
  align-items: center;
  margin-right: var(--space-1);
}
.oa-tour button {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 0;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}
.oa-tour button::after {
  content: "";
  width: 15px;
  height: 15px;
  background: currentColor;
  display: block;
  margin: auto;
}
#tour-prev::after {
  mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10.828 12l4.95 4.95-1.414 1.415L8 12l6.364-6.364 1.414 1.414z"/></svg>') center / contain no-repeat;
  -webkit-mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M10.828 12l4.95 4.95-1.414 1.415L8 12l6.364-6.364 1.414 1.414z"/></svg>') center / contain no-repeat;
}
#tour-next::after {
  mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.172 12l-4.95-4.95 1.414-1.415L16 12l-6.364 6.364-1.414-1.414z"/></svg>') center / contain no-repeat;
  -webkit-mask: url('data:image/svg+xml;utf8,<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.172 12l-4.95-4.95 1.414-1.415L16 12l-6.364 6.364-1.414-1.414z"/></svg>') center / contain no-repeat;
}
.oa-tour output {
  box-sizing: border-box;
  display: grid;
  place-items: center;
  min-width: 5ch;
  height: 44px;
  padding: 0 var(--space-1);
  text-align: center;
  font-size: var(--text-xs);
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.oa-tour .oa-tour-sep {
  width: 1px;
  height: 24px;
  background: var(--border);
  margin: 0 var(--space-1);
}
@media (hover: hover) and (pointer: fine) {
  .oa-tour button:hover { background: var(--surface-2); color: var(--fg); }
}
.oa-tour button:active {
  background: var(--surface-2);
  color: var(--fg);
  transform: translateY(1px);
}
.oa-tour button:focus-visible { outline: none; box-shadow: var(--focus-ring); }

/* Usability of a pan/zoom plane tracks viewport WIDTH, not input type: a
   touchscreen laptop drives a canvas fine, a narrow mouse-driven window does
   not. Below 640px the plane linearizes into a scrolling stack rather than
   shipping a pinch handler that fights native scroll. */
@media (max-width: 640px) {
  /* The stacked read is a document again: selection returns with scrolling. */
  .oa-canvas { height: auto; overflow: visible; touch-action: auto; user-select: auto; -webkit-user-select: auto; cursor: auto; background-image: none; }
  .oa-plane { position: static; transform: none; display: flex; flex-direction: column; gap: var(--space-8); padding: var(--space-4); }
  .oa-plane[data-spotlight] .oa-frame:not([data-lit]),
  .oa-plane[data-spotlight] .oa-note:not([data-lit]),
  .oa-plane[data-spotlight] .oa-connectors path:not([data-lit]) { opacity: 1; }
  .oa-frame { position: static; width: 100%; }
  .oa-frame-label { position: relative; transform: none; margin-bottom: var(--space-2); }
  .oa-frame-body { height: auto; min-height: 60vh; }
  .oa-note { position: static; max-width: 100%; }
  .oa-zoom, .oa-connectors, .oa-tour { display: none; }
}
```

## The vendored runtime — JS

```js
(function () {
  const canvas = document.getElementById("canvas");
  const plane = document.getElementById("plane");
  const pct = document.getElementById("zoom-pct");
  const frames = [...canvas.querySelectorAll(".oa-frame")];
  const notes = [...canvas.querySelectorAll(".oa-note")];
  if (!frames.length) return;

  const MIN = 0.1;
  const MAX = 4;
  const PAD = 48;
  const FRICTION = 0.998;
  const RUBBER = 0.55;
  const FLICK = 0.11;
  const VEL_WIN = 100;
  const CHIP_K = 0.5;
  // Press+release under TAP_SLOP css-px is a tap; past it is a pan.
  const TAP_SLOP = 6;
  // Spotlight dim for non-lit frames / connector paths (written to CSS vars).
  const SPOT_DIM = { frame: 0.4, path: 0.15 };
  canvas.style.setProperty("--spot-dim-frame", String(SPOT_DIM.frame));
  canvas.style.setProperty("--spot-dim-path", String(SPOT_DIM.path));
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const compact = matchMedia("(max-width: 640px)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const view = { x: 0, y: 0, k: 1 };
  let raf = 0;
  let focused = null;

  // --- Tour state ---
  const tour = frames
    .filter((f) => f.dataset.tour)
    .sort((a, b) => +a.dataset.tour - +b.dataset.tour);
  let tourIndex = -1;
  const tourStatus = document.getElementById("tour-status");
  const tourPrev = document.getElementById("tour-prev");
  const tourNext = document.getElementById("tour-next");
  const tourGroup = tourPrev?.closest(".oa-tour");
  if (tourGroup && !tour.length) tourGroup.style.display = "none";

  // --- Pointer / velocity state ---
  const pointers = new Map();
  let pinch = null;
  const samples = [];
  let drag = null;
  let space = false;
  let pressTarget = null;
  // Pointer gestures consume the trailing compat click so tap() does not
  // double-fire; assistive clicks arrive with no prior pointer and pass through.
  let clickConsumed = false;
  let applyingHash = false;

  // --- Spotlight adjacency map ---
  const adj = new Map();
  for (const p of canvas.querySelectorAll(".oa-connectors path[data-from][data-to]")) {
    const from = p.dataset.from;
    const to = p.dataset.to;
    if (!adj.has(from)) adj.set(from, { frames: new Set(), paths: new Set() });
    if (!adj.has(to)) adj.set(to, { frames: new Set(), paths: new Set() });
    adj.get(from).frames.add(to);
    adj.get(from).paths.add(p);
    adj.get(to).frames.add(from);
    adj.get(to).paths.add(p);
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const box = (f) => ({
    x: +f.style.getPropertyValue("--x"),
    y: +f.style.getPropertyValue("--y"),
    w: +f.style.getPropertyValue("--w"),
    h: +f.style.getPropertyValue("--h"),
  });

  function setNoteCollapsed(note, collapsed) {
    note.dataset.collapsed = String(collapsed);
    delete note.dataset.open;
    if (collapsed) {
      note.tabIndex = 0;
      note.setAttribute("role", "button");
      note.setAttribute("aria-expanded", "false");
    } else {
      note.removeAttribute("tabindex");
      note.removeAttribute("role");
      note.removeAttribute("aria-expanded");
    }
  }

  function toggleNote(note) {
    const open = note.dataset.open !== "true";
    note.dataset.open = String(open);
    note.setAttribute("aria-expanded", String(open));
  }

  function paint() {
    const s = canvas.style;
    s.setProperty("--tx", `${view.x}px`);
    s.setProperty("--ty", `${view.y}px`);
    s.setProperty("--k", view.k);
    s.setProperty("--dot-o", clamp((view.k - 0.3) * 1.8, 0, 1));
    pct.value = `${Math.round(view.k * 100)}%`;
    const collapsed = view.k < CHIP_K;
    for (const n of notes) {
      if (n.dataset.collapsed !== String(collapsed)) {
        setNoteCollapsed(n, collapsed);
      }
    }
  }

  let paintPending = false;
  function schedulePaint() {
    if (paintPending) return;
    paintPending = true;
    requestAnimationFrame(() => { paintPending = false; paint(); });
  }

  // --- Bounds & legal range ---

  function bounds() {
    const bs = frames.map(box);
    const x = Math.min(...bs.map((b) => b.x));
    const y = Math.min(...bs.map((b) => b.y));
    return {
      x, y,
      w: Math.max(...bs.map((b) => b.x + b.w)) - x,
      h: Math.max(...bs.map((b) => b.y + b.h)) - y,
    };
  }

  function legalRange() {
    const b = bounds();
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const cw = b.w * view.k;
    const ch = b.h * view.k;
    const ox = b.x * view.k;
    const oy = b.y * view.k;
    return {
      minX: cw < vw ? (vw - cw) / 2 - ox : vw - PAD - cw - ox,
      maxX: cw < vw ? (vw - cw) / 2 - ox : PAD - ox,
      minY: ch < vh ? (vh - ch) / 2 - oy : vh - PAD - ch - oy,
      maxY: ch < vh ? (vh - ch) / 2 - oy : PAD - oy,
    };
  }

  // Apple rubber-band: displacement is damped so over-scroll feels elastic.
  function rubber(over, dim) {
    const sign = over < 0 ? -1 : 1;
    const abs = Math.abs(over);
    return sign * (abs * dim * RUBBER) / (dim + RUBBER * abs);
  }

  // Apply rubber-banding to current view position.
  function applyRubber() {
    const r = legalRange();
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    if (view.x < r.minX) view.x = r.minX + rubber(view.x - r.minX, vw);
    else if (view.x > r.maxX) view.x = r.maxX + rubber(view.x - r.maxX, vw);
    if (view.y < r.minY) view.y = r.minY + rubber(view.y - r.minY, vh);
    else if (view.y > r.maxY) view.y = r.maxY + rubber(view.y - r.maxY, vh);
  }

  // --- Velocity sampling ---

  function sample(e) {
    const now = performance.now();
    samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (samples.length > 1 && now - samples[0].t > VEL_WIN) samples.shift();
  }

  function velocity() {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t || 1;
    return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
  }

  // --- Tween & glide (share raf handle, mutually interruptible) ---

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

  function settle() {
    const r = legalRange();
    const tx = clamp(view.x, r.minX, r.maxX);
    const ty = clamp(view.y, r.minY, r.maxY);
    const tk = clamp(view.k, MIN, MAX);
    if (Math.abs(tx - view.x) > 0.5 || Math.abs(ty - view.y) > 0.5 ||
        Math.abs(tk - view.k) > 0.001) {
      tweenTo({ x: tx, y: ty, k: tk }, 320);
    }
  }

  // Momentum glide after a flick. Shares the raf handle so a pointerdown
  // cancels it mid-flight (interruptibility per motion.md).
  function glide(vx, vy) {
    if (reduced.matches) { settle(); return; }
    cancelAnimationFrame(raf);
    let prev = performance.now();
    const step = (now) => {
      const dt = now - prev;
      prev = now;
      const decay = FRICTION ** dt;
      vx *= decay;
      vy *= decay;
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) { settle(); return; }
      view.x += vx * dt;
      view.y += vy * dt;
      const r = legalRange();
      const overX = view.x < r.minX ? view.x - r.minX : view.x > r.maxX ? view.x - r.maxX : 0;
      const overY = view.y < r.minY ? view.y - r.minY : view.y > r.maxY ? view.y - r.maxY : 0;
      if (overX) { vx *= 0.6; }
      if (overY) { vy *= 0.6; }
      paint();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // --- Zoom helpers ---

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
    schedulePaint();
  }

  function fitTo(b, ms) {
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const k = clamp(Math.min((vw - PAD * 2) / b.w, (vh - PAD * 2) / b.h), MIN, MAX);
    tweenTo({ k, x: (vw - b.w * k) / 2 - b.x * k, y: (vh - b.h * k) / 2 - b.y * k }, ms);
  }

  // --- Spotlight ---

  function spotlight(frame) {
    if (!frame || !frame.id || focused) {
      delete plane.dataset.spotlight;
      for (const f of frames) delete f.dataset.lit;
      for (const n of notes) delete n.dataset.lit;
      for (const p of canvas.querySelectorAll(".oa-connectors path")) delete p.dataset.lit;
      return;
    }
    plane.dataset.spotlight = "";
    frame.dataset.lit = "";
    const info = adj.get(frame.id);
    if (info) {
      for (const id of info.frames) {
        const el = document.getElementById(id);
        if (el) el.dataset.lit = "";
      }
      for (const p of info.paths) p.dataset.lit = "";
    }
  }

  // --- Focus ---

  function focus(frame, instant = false) {
    if (compact.matches) return;
    focused?.removeAttribute("data-focused");
    focused = frame;
    spotlight(null);
    for (const f of frames) {
      f.querySelector(".oa-frame-body").inert = f !== frame;
    }
    if (!frame) {
      tourIndex = -1;
      updateTourUI();
      fitTo(bounds(), instant ? 0 : 320);
      updateHash(null);
      return;
    }
    frame.setAttribute("data-focused", "");
    fitTo(box(frame), instant ? 0 : 400);
    // Sync tour index if this frame is in the tour.
    const ti = tour.indexOf(frame);
    if (ti !== -1) tourIndex = ti;
    updateTourUI();
    updateHash(frame);
  }

  // --- Hash / deep-link ---

  function updateHash(frame) {
    if (applyingHash) return;
    const hash = frame ? "#" + frame.id : "";
    if (location.hash !== hash) {
      applyingHash = true;
      history.replaceState(null, "", hash || location.pathname + location.search);
      applyingHash = false;
    }
  }

  function applyHash() {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    const frame = frames.find((f) => f.id === id);
    if (frame && frame !== focused) {
      applyingHash = true;
      focus(frame);
      applyingHash = false;
    }
  }

  // --- Tour ---

  function updateTourUI() {
    if (!tourStatus) return;
    if (tourIndex >= 0 && tour.length) {
      tourStatus.value = `${tourIndex + 1} / ${tour.length}`;
    } else {
      tourStatus.value = `- / ${tour.length}`;
    }
  }

  function tourStep(delta) {
    if (!tour.length) return;
    let next = tourIndex + delta;
    if (next < 0) next = tour.length - 1;
    if (next >= tour.length) next = 0;
    tourIndex = next;
    focus(tour[tourIndex]);
  }

  // --- Tap -> focus ---

  // Walk out of open shadow roots so authored web components still resolve
  // against CONTROLS / .oa-frame / .oa-note in the light DOM.
  function closestCrossing(el, sel) {
    let node = el;
    while (node instanceof Element) {
      const hit = node.closest(sel);
      if (hit) return hit;
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }

  function eventDeepTarget(e) {
    const t = e.composedPath()[0];
    return t instanceof Element ? t : e.target;
  }

  // A tap (press + release under TAP_SLOP) is the canvas click, resolved from
  // the pointerdown hit target. The native click cannot be trusted for this:
  // pointer capture retargets it to the canvas in some engines, which read as
  // "background" and exited the frame the press had just focused.
  // Returns true when the camera moved (so endDrag skips settle over the tween).
  function tap(target) {
    if (!(target instanceof Element) || !target.isConnected) return false;
    const note = closestCrossing(target, ".oa-note");
    if (note && note.dataset.collapsed === "true") {
      toggleNote(note);
      return false;
    }
    const frame = closestCrossing(target, ".oa-frame");
    if (frame && frame !== focused) {
      focus(frame);
      return true;
    }
    if (!frame) {
      focus(null);
      return true;
    }
    return false;
  }

  // Double-click on background: zoom in at pointer. Shift = zoom out.
  canvas.addEventListener("dblclick", (e) => {
    if (compact.matches || closestCrossing(eventDeepTarget(e), ".oa-zoom")) return;
    // Same retargeting hazard as tap(): prefer the press target when connected.
    const origin = pressTarget?.isConnected ? pressTarget : eventDeepTarget(e);
    if (closestCrossing(origin, ".oa-frame, .oa-note")) return;
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const targetK = clamp(view.k * (e.shiftKey ? 0.5 : 2), MIN, MAX);
    const ratio = targetK / view.k;
    tweenTo({
      k: targetK,
      x: cx - (cx - view.x) * ratio,
      y: cy - (cy - view.y) * ratio,
    }, 200);
  });

  // Assistive tech activates role=button chips via a synthetic click with no
  // pointerdown/up. Pointer taps already ran tap() in endDrag and set
  // clickConsumed so this path does not double-toggle.
  canvas.addEventListener("click", (e) => {
    if (clickConsumed) { clickConsumed = false; return; }
    if (compact.matches || closestCrossing(eventDeepTarget(e), ".oa-zoom")) return;
    tap(eventDeepTarget(e));
  });

  // Collapsed chips are keyboard-reachable.
  for (const n of notes) {
    n.addEventListener("keydown", (e) => {
      if (n.dataset.collapsed !== "true") return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      toggleNote(n);
    });
  }

  // Label focus -> frame focus (keyboard navigation). Labels are pan surface
  // for the pointer (tap() focuses on release); keyboard still enters on focus.
  for (const frame of frames) {
    const label = frame.querySelector(".oa-frame-label");
    label.addEventListener("focus", () => {
      if (frame !== focused) focus(frame, true);
    });
    // Spotlight on label focusin (keyboard-driven).
    label.addEventListener("focusin", () => {
      if (!focused) spotlight(frame);
    });
    label.addEventListener("focusout", () => spotlight(null));
  }

  // --- Spotlight via hover (fine-pointer only) ---

  if (finePointer.matches) {
    canvas.addEventListener("pointerover", (e) => {
      if (focused || compact.matches) return;
      const frame = closestCrossing(eventDeepTarget(e), ".oa-frame");
      if (frame) spotlight(frame);
    });
    canvas.addEventListener("pointerout", (e) => {
      if (focused || compact.matches) return;
      const frame = closestCrossing(eventDeepTarget(e), ".oa-frame");
      if (frame) spotlight(null);
    });
  }

  // --- Wheel ---

  canvas.addEventListener("wheel", (e) => {
    if (compact.matches) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey) {
      zoomAt(Math.exp(-dy / 200), e.clientX - r.left, e.clientY - r.top);
    } else {
      view.x -= dx;
      view.y -= dy;
      // Rubber-band on wheel-pan at edges.
      const lr = legalRange();
      if (view.x < lr.minX || view.x > lr.maxX ||
          view.y < lr.minY || view.y > lr.maxY) {
        applyRubber();
      }
      schedulePaint();
    }
  }, { passive: false });

  // --- Pointer events (drag, pinch, velocity) ---

  // In-frame operable widgets own the pointer. Frame labels are canvas chrome
  // (Figma-style): pan surface that tap-to-focuses. Do not add [role=button]
  // here — collapsed note chips use that role and must reach tap().
  const CONTROLS =
    "a[href], button, input, select, textarea, summary, label, [contenteditable]:not([contenteditable=\"false\"]), audio[controls], video[controls]";

  function isPointerControl(el) {
    const control = closestCrossing(el, CONTROLS);
    return !!(control && !control.classList.contains("oa-frame-label"));
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (compact.matches || e.button !== 0 ||
        closestCrossing(eventDeepTarget(e), ".oa-zoom")) return;
    // Cancel any in-flight animation immediately (interruptibility).
    cancelAnimationFrame(raf);
    const deep = eventDeepTarget(e);
    // Hit target before any capture retargeting — tap() resolves against it.
    pressTarget = deep;

    // Ownership before tracking: control presses never enter the pointers Map
    // (no capture → an off-canvas lift would otherwise leave a ghost pinch).
    // Space-drag still pans from controls.
    if (!space && isPointerControl(deep)) return;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    samples.length = 0;

    // Two pointers = pinch.
    if (pointers.size === 2) {
      drag = null;
      canvas.removeAttribute("data-panning");
      const pts = [...pointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      pinch = {
        d0: Math.hypot(dx, dy),
        k0: view.k,
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2,
      };
      return;
    }
    if (pointers.size > 2) return;

    drag = { px: e.clientX, py: e.clientY, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
    canvas.setAttribute("data-panning", "");
    sample(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (compact.matches) return;
    const ptr = pointers.get(e.pointerId);
    if (ptr) { ptr.x = e.clientX; ptr.y = e.clientY; }

    // Pinch-zoom with two pointers. k0/d0 stay fixed from pinch start so
    // overshoot past MIN/MAX can rubber; settle() snaps k back on release.
    if (pinch && pointers.size === 2) {
      const pts = [...pointers.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const d = Math.hypot(dx, dy);
      const rawK = pinch.k0 * (d / pinch.d0);
      // Same rubber() as pan over-scroll: elastic past the hard clamp.
      const k = rawK < MIN ? MIN + rubber(rawK - MIN, 1)
        : rawK > MAX ? MAX + rubber(rawK - MAX, 1)
        : rawK;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const r = canvas.getBoundingClientRect();
      const cx = mx - r.left;
      const cy = my - r.top;
      const ratio = k / view.k;
      view.x = cx - (cx - view.x) * ratio;
      view.y = cy - (cy - view.y) * ratio;
      // Also pan by midpoint delta.
      view.x += mx - pinch.mx;
      view.y += my - pinch.my;
      view.k = k;
      pinch.mx = mx;
      pinch.my = my;
      paint();
      return;
    }

    if (!drag) return;
    sample(e);
    const ddx = e.clientX - drag.px;
    const ddy = e.clientY - drag.py;
    drag.moved += Math.abs(ddx) + Math.abs(ddy);
    drag.px = e.clientX;
    drag.py = e.clientY;
    view.x += ddx;
    view.y += ddy;
    // Apply rubber-banding during drag.
    const lr = legalRange();
    if (view.x < lr.minX || view.x > lr.maxX ||
        view.y < lr.minY || view.y > lr.maxY) {
      applyRubber();
    }
    schedulePaint();
  });

  function endDrag(e) {
    pointers.delete(e.pointerId);
    // Pinch ended: if one pointer remains, re-init drag from it.
    if (pinch) {
      pinch = null;
      if (pointers.size === 1) {
        const remaining = [...pointers.values()][0];
        // Past TAP_SLOP so a resumed pinch is never classified as a tap.
        drag = { px: remaining.x, py: remaining.y, moved: TAP_SLOP + 1 };
        samples.length = 0;
        canvas.setAttribute("data-panning", "");
      } else {
        settle();
      }
      return;
    }
    if (!drag) return;
    // pointercancel is never a tap: the gesture was taken by the system.
    const tapped = e.type === "pointerup" && drag.moved <= TAP_SLOP && !space;
    // Momentum: check velocity and glide or settle.
    const v = velocity();
    const speed = Math.hypot(v.vx, v.vy);
    drag = null;
    canvas.releasePointerCapture(e.pointerId);
    canvas.removeAttribute("data-panning");
    // A completed pointerup owns the trailing compat click; pointercancel
    // does not produce one, so leave the flag clear for assistive clicks.
    clickConsumed = e.type === "pointerup";
    // A tap that re-aimed the camera owns the tween; don't settle over it.
    if (tapped && tap(pressTarget)) return;
    if (speed > FLICK && !space) {
      glide(v.vx, v.vy);
    } else {
      settle();
    }
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // --- Keyboard ---

  addEventListener("keydown", (e) => {
    if (compact.matches) return;
    // Same CONTROLS vocabulary as pointer ownership (including frame labels as
    // real <button>s so Space activates them instead of latching pan).
    if (e.target.closest(CONTROLS)) {
      // Exception: let Escape bubble out of controls.
      if (e.key !== "Escape") return;
    }
    if (e.code === "Space") { space = true; return e.preventDefault(); }
    if (e.key === "0" || e.key.toLowerCase() === "f") focus(null, true);
    else if (e.key === "1") centerZoom(1 / view.k);
    else if (e.key === "Escape") focus(null, true);
    else if (e.key === "+" || e.key === "=") centerZoom(1.2);
    else if (e.key === "-") centerZoom(1 / 1.2);
    // Left/Right: tour step if tour exists, else pan.
    else if (e.key === "ArrowLeft") { tour.length >= 2 ? tourStep(-1) : pan(60, 0); }
    else if (e.key === "ArrowRight") { tour.length >= 2 ? tourStep(1) : pan(-60, 0); }
    else if (e.key === "ArrowUp") pan(0, 60);
    else if (e.key === "ArrowDown") pan(0, -60);
    else return;
    e.preventDefault();
  });
  addEventListener("keyup", (e) => { if (e.code === "Space") space = false; });

  // --- Zoom cluster + tour button wiring ---

  document.getElementById("zoom-in")?.addEventListener("click", () => centerZoom(1.2));
  document.getElementById("zoom-out")?.addEventListener("click", () => centerZoom(1 / 1.2));
  document.getElementById("zoom-fit")?.addEventListener("click", () => focus(null));
  tourPrev?.addEventListener("click", () => tourStep(-1));
  tourNext?.addEventListener("click", () => tourStep(1));

  // --- Hash listener ---

  addEventListener("hashchange", () => {
    if (applyingHash) return;
    applyHash();
  });

  // --- Init ---

  function init() {
    if (compact.matches) {
      cancelAnimationFrame(raf);
      canvas.removeAttribute("style");
      focused?.removeAttribute("data-focused");
      focused = null;
      tourIndex = -1;
      spotlight(null);
      for (const f of frames) f.querySelector(".oa-frame-body").inert = false;
      for (const n of notes) setNoteCollapsed(n, false);
      updateTourUI();
      return;
    }
    focus(null);
    fitTo(bounds(), 0);
    updateTourUI();
    // Apply deep link after initial fit.
    requestAnimationFrame(() => applyHash());
  }
  compact.addEventListener("change", init);
  addEventListener("resize", () => {
    if (compact.matches) return;
    if (focused) fitTo(box(focused), 0);
    else fitTo(bounds(), 0);
  });
  init();
})();
```

## Markup shape

Frames carry world coordinates as inline custom properties. `--x/--y/--w/--h`
are unitless pixel numbers describing the **body**.

```html
<div class="oa-canvas" id="canvas" role="group"
     aria-label="Canvas. Drag or Space-drag to pan, pinch or ctrl-scroll to zoom, double-click to zoom in, Shift+double-click to zoom out, click a frame or its label to focus. Escape returns to overview.">
  <div class="oa-plane" id="plane">
    <!-- connectors: one inline SVG in world coords, behind the frames.
         data-from/data-to reference frame ids for spotlight linking. -->
    <svg class="oa-connectors" aria-hidden="true">
      <path d="M ..." data-from="login" data-to="dashboard"/>
    </svg>

    <!-- Every frame MUST have a human-readable kebab-case id (deep-link key).
         Optional data-tour="n" enrolls the frame in the guided tour. -->
    <section class="oa-frame" id="login" data-tour="1"
             style="--x:0;--y:0;--w:390;--h:844">
      <button class="oa-frame-label" type="button">Login</button>
      <div class="oa-frame-body" inert><!-- real, operable UI --></div>
    </section>

    <section class="oa-frame" id="dashboard" data-tour="2"
             style="--x:510;--y:0;--w:1440;--h:900">
      <button class="oa-frame-label" type="button">Dashboard</button>
      <div class="oa-frame-body" inert><!-- real, operable UI --></div>
    </section>

    <p class="oa-note" style="--x:150;--y:920">Cold-start empty state still open.</p>
  </div>
</div>
```

The builder appends the zoom cluster. When at least one frame has `data-tour`,
it also appends the tour controls. Authored controls with these classes or IDs
fail validation.

### Required DOM contract (what the runtime expects)

The runtime looks up these elements by id; your body fragment **must** supply
the canvas/plane/frames and **must not** supply the controls (the builder
injects those):

| Element              | Who authors it | Notes                                            |
|----------------------|----------------|--------------------------------------------------|
| `#canvas`             | you            | one `.oa-canvas` container with `role="group"`   |
| `#plane`              | you            | one `.oa-plane` inside `#canvas`, holds frames   |
| `.oa-frame` sections | you            | each a `<section>` with kebab `id`, `--x/--y/--w/--h` |
| `.oa-note`            | you (optional) | freeform notes, see the freeform contract        |
| `svg.oa-connectors`   | you (optional) | one inline SVG in world coords                    |
| `#zoom-in`/`#zoom-out`/`#zoom-fit`/`#zoom-pct` | builder | do not author these ids            |
| `#tour-prev`/`#tour-next`/`#tour-status`     | builder | do not author; only present when a frame has `data-tour` |

If your markup omits `#canvas` or `#plane`, or nests `#plane` outside
`#canvas`, validation fails before publish.

## The frame contract

Frames are first-class: a real `<section>`, a `<button>` label that is the
keyboard entry point, a bounded body. Size to real device or slide dimensions
(390×844, 1440×900, 1600×900), but **mix sizes** — five identical 1440×900
frames span a ~3000×3060 bounding rect that pushes the initial fit to ~0.25×,
drowning the composition in whitespace.

The overview fit ratio is `k ≈ viewport / bounding` (the runtime fits the
bounding rect into the viewport, minus `PAD`). To land overview zoom at
`≥ ~0.5×` — the `CHIP_K` threshold below which notes collapse to chips —
**keep BOTH bounding dimensions under the caps** the `validate` gate enforces:
width ≤ 2880 world px (~2.25× a 1280-px viewport) and height ≤ 2560 world px
(~2.5× a 1024-px viewport). The width cap clears the "three mobiles + one
desktop" row (~2610–2970px) while still failing the five-1440-row anti-pattern
(~7680); the height cap catches a long single column drowning in vertical
whitespace — the same defect rotated. A legitimately large canvas breaks into a
GRID that keeps both dims under the caps, not a wide row or a tall column. If
you need a wide desktop frame, pair it with mobile frames stacked vertically
(not a second wide frame beside it) so the bounding *width* stays small. Gutter
≥ 120 world px so counter-scaled labels never collide at low zoom, but no wider
— a 200+ px gap is dead space the fit must shrink past. Lay frames out with
intent — a row is
a flow, a grid is a set of variants — not scattered across empty pixels.

Unfocused frame bodies carry `inert`, which removes them from hit-testing *and*
the tab order in one move. `pointer-events: none` would do neither job: it
leaves controls tabbable while mouse-dead, and it lets a click fall through to
the viewport so `closest(".oa-frame")` returns `null` and the frame can never be
focused by clicking it. Put `inert` on `.oa-frame-body` only — on the wrapper it
kills click-to-focus for the same reason.

Pointer ownership follows the Figma model, not a per-frame lock. Frame labels
are canvas chrome: pan surface that tap-to-focuses on pointerup. In-frame
operable widgets (fields, buttons, links, summary, media controls, editable
regions) keep the pointer; a drag from anywhere else pans, including focused
frame text. Focus resolves from the pointerdown hit target on pointerup —
never from the native `click` event, which pointer capture retargets to the
canvas in some engines (the retargeted click read as "background" and exited
the frame the press had just focused). A synthetic click with no prior pointer
(assistive tech on note chips) still reaches `tap()` via the canvas click
listener; pointer gestures set `clickConsumed` so the trailing compat click
does not double-fire. Text selection follows the same line: none on the pan
surface (a selection drag and a pan cannot share a gesture), native inside
editable fields (`contenteditable="false"` stays pan surface), back to normal
in the compact stacked read.

A frame holds a bounded screen/slide/variant. Build the UI for real, with real
states -- the "no fake screenshots" ban in `design.md` explicitly exempts the case
where the artifact *is* the prototype, and a canvas of frames is that case.

**Every frame must have an `id`.** Human-readable kebab-case derived from the
frame's purpose: `id="login"`, `id="settings-billing"`, never `id="frame-1"`
or `id="f2"`. The id is the deep-link anchor (`#login` opens and focuses that
frame), the spotlight adjacency key, and the inspectable-markup requirement
from `design.md`. A frame without an id breaks deep links and spotlight.

**Tour order is spatial narrative.** When `data-tour` attributes are present,
adjacent tour steps must be spatial neighbors or connected by a visible
connector path. The camera movement between steps reads as travel through the
composition, not teleportation. Number steps by the story's reading order.

## The freeform contract

Between frames: sticky notes (`.oa-note`, `--accent-soft` + one `--elev-ring`),
annotations, connector lines (one inline `<svg class="oa-connectors">` in world
coordinates, `stroke: var(--border)`, accent only to mark the primary path), and
a legend (a `.oa-note`). Freeform elements take `--x`/`--y` but no label and no
focus behavior.

**Every connector path must carry `data-from` and `data-to` referencing real
frame ids.** A connector without these attributes cannot participate in spotlight
highlighting, and likely represents a decorative line rather than a real relation.
No decorative spaghetti.

**Connector path `d` is in the same world-px coordinate space as frame
`--x/--y/--w/--h`.** The runtime renders whatever path you author, so a
mis-aimed connector is silent — aim it at the frame edges you want it to
touch. Compute edge midpoints from each frame's box:

- right-edge midpoint of frame A `(Ax, Ay, Aw, Ah)` = `(Ax+Aw, Ay+Ah/2)`
- left-edge midpoint of frame B = `(Bx, By+Bh/2)`
- top/bottom-edge midpoints = `(x+w/2, y)` and `(x+w/2, y+h)` for vertical flow

A horizontal A→B connector from A's right edge to B's left edge:

```svg
<path d="M ${Ax+Aw} ${Ay+Ah/2} C ${(Ax+Aw+Bx)/2} ${Ay+Ah/2}, ${(Ax+Aw+Bx)/2} ${By+Bh/2}, ${Bx} ${By+Bh/2}"
      data-from="A" data-to="B"/>
```

The two control points sit on the vertical midline between the frames so the
cubic bezier enters and leaves horizontally — a clean S-curve. For a vertical
flow (A bottom → B top), swap to `M ${Ax+Aw/2} ${Ay+Ah}` with control points on
the horizontal midline. Round to integers; the runtime counter-scales stroke
width so sub-pixel precision is not needed.

For a **diagonal** flow (A bottom-mid in one row → B top-mid in a row below
and to the side), aim each control at a point on the midline *perpendicular to
the entry/exit edge* — the bezier then enters A's bottom edge vertically and
leaves B's top edge vertically, bending across both axes between. From A's
bottom midpoint `(Ax+Aw/2, Ay+Ah)` to B's top midpoint `(Bx+Bw/2, By)`:

```svg
<path d="M ${Ax+Aw/2} ${Ay+Ah}
         C ${Ax+Aw/2} ${(Ay+Ah+By)/2}, ${Bx+Bw/2} ${(Ay+Ah+By)/2}, ${Bx+Bw/2} ${By}"
      data-from="A" data-to="B"/>
```

The two control points share the vertical midline between the two frames'
rows (`y = (Ay+Ah+By)/2`), so the curve drops straight out of A and rises
straight into B, sweeping sideways in between — a clean S that reads as flow
even at overview zoom.


**Place notes in the gutters, not over frames.** A note's `--x/--y` is its
top-left while expanded and its center while collapsed; `max-width: 28ch`
counter-scales to ~3× at low overview zoom, so a note whose box intersects a
frame body lands *on top of* that frame's content. A note is ~22ch wide and
~120 world px tall expanded, so before placing one compute its right edge
(`--x + ~22ch ≈ --x + 360 world px`) and bottom edge (`--y + ~120 world px`)
and confirm neither crosses a frame's `--x..--x+--w` / `--y..--y+--h`
rectangle.

Gutters are not guaranteed — a single row of mobile frames with a 120 px
gap has no vertical gutter beside any frame, only the row-gap above/below.
Pick the placement by what space actually exists:

| Layout                      | Safe note placement                            |
|-----------------------------|------------------------------------------------|
| Two columns with a wide gutter between them | In the vertical gutter, centered on the connector |
| Single row, tight gap       | Row-gap below the frames (above the next row), centered on the connector |
| Single frame, full-width    | Above or below the frame, never overlapping it |
| Grid with row gaps          | Row-gap between rows, never inside a frame box |

If no placement clears all frame rectangles, move the note further out or
drop it — a note overlapping a frame body reads as a bug at overview zoom.


At overview zoom (`--k < 0.5`) the runtime collapses each note to a small
accent chip (the vendored Remix `ri-edit` glyph, masked so it inherits
`--accent` in both themes) so counter-scaled text does not clutter the plane.
Clicking a chip — or Enter/Space on it, chips are focusable buttons — pins it
open in place; crossing the zoom threshold resets the pin, and zooming in past
the threshold expands every note. Author content lives inside the note as
normal — no markup change needed; the runtime adds `tabindex`, `role`, and
`aria-expanded` only while the note is collapsed.

## Accessibility

Frame labels are real buttons, so tab order walks the frames in **DOM order,
which must match reading order, not spatial order**. Activating a label focuses
its frame and un-`inert`s its body, so the next Tab enters the frame's own
controls. For the pointer, labels are pan surface that tap-to-focuses on
release (Figma chrome); keyboard focus still enters instantly. `Escape`, `0`,
`F`, and the fit button all return to the overview; `1` = 100%; `+`/`-` zoom
about the viewport center; arrows pan (or step the tour when `data-tour`
frames exist). The keydown handler bails on the same `CONTROLS` vocabulary as
pointer ownership (`a[href]`, `button`, fields, `summary`, `label`, editable
regions, media with controls), so a focused frame's widgets keep their
keystrokes — including Space on `<summary>` / media — instead of latching
space-pan.

Every tween checks `prefers-reduced-motion` and jumps instantly; spotlight
state changes also drop their transition. Tabbing to a frame label uses an
instant camera jump because keyboard focus is a high-frequency navigation
action. Frame labels counter-scale by `1/k` (capped at 3x) and extend their
hit area to at least 44px via `::before`. Zoom-cluster buttons and collapsed
note chips also have 44px targets.

**Multi-touch pinch is implemented.** The runtime tracks up to two pointers
via a `pointers` Map. When two pointers are active, drag is cancelled and the
runtime zooms about their midpoint from the pinch-start `k0`/`d0` baseline.
Past MIN/MAX the same `rubber()` used for pan over-scroll softens the
overshoot; releasing snaps `k` back via `settle()`. A third pointer is ignored.
Falling to one pointer re-samples velocity for a potential flick.
`touch-action: none` is required on the canvas for this to work (it suppresses
native pinch, which would fight the custom handler). Below 640px the plane is
stacked and pinch is not active.

**Tour keyboard model.** When `data-tour` frames exist and `tour.length >= 2`:
Left/Right arrow keys step through the tour (this is a named exception to the
"arrows pan" rule, per the frequency table in `motion.md`: tours are
occasional and deliberate). Up/Down still pan. Without `data-tour` frames,
all four arrow keys pan (backwards compatible). Tour steps animate the camera
at the standard 400ms fit tween; `prefers-reduced-motion` makes them instant.
`Escape` returns to overview and resets the tour index. Prev/next buttons are
real `<button>` elements with `aria-label`. Progress is an `<output>` showing
"n / N" in tabular-nums.

**Deep links via `#frame-id`.** On load, if `location.hash` matches a frame
id, that frame receives focus (with the standard fit animation, or instantly
under reduced-motion). Clicking or tabbing to a frame updates the hash via
`history.replaceState` (no new history entries, so Back does not step through
frames). Returning to overview clears the hash. A `hashchange` listener
handles external navigation (shared links, bookmarks).

**Encrypted canvases can't deep-link.** A plain canvas renders its content
directly in the viewer document, so `location.hash` is the page's own hash and
deep links work as described. An *encrypted* canvas renders inside the viewer's
sandboxed `srcdoc` iframe, which has an opaque origin — its `location.hash` is
independent of the parent URL, so `#frame-id` in the shareable URL does not
reach `applyHash()` and the canvas opens at overview, not at the linked frame.
There is no cross-origin bridge; if you need deep links into an encrypted
canvas, drop encryption or accept overview-on-open.

**Spotlight is driven by hover and focus**, never applied decoratively.
Hovering a frame (gated behind `@media (hover: hover) and (pointer: fine)`)
or focusing a frame label via keyboard both activate spotlight on that frame
and its connected neighbors. Moving the pointer away or blurring the label
clears spotlight. When a frame is focused (zoomed in), spotlight is
suppressed. Spotlight never weakens the focus ring.

**The mobile story.** Below 640px the plane linearizes into a scrolling stack
of full-width frames; the grid, connectors, zoom cluster, and tour controls
hide, and every handler bails. Spotlight is also disabled (opacity overridden
to 1). The gate is viewport **width**, not `(pointer: coarse)` -- a
touchscreen laptop drives a canvas fine, while a narrow mouse-driven window
cannot, so input type is the wrong signal. Crossing the breakpoint live
re-runs `init()` in both directions.

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
- No infinite plane holding one frame -- that is a document, so drop `--canvas`.
- No auto-playing tours. The tour is driven by the viewer (click or arrow key),
  never a timed slideshow or screensaver.
- No arbitrary tour order. Tour steps must follow the spatial narrative rule
  (adjacent steps are neighbors or connected). Random jumps across the canvas
  break the travel metaphor.
- No `frame-1` / `f2` / `section-3` hash ids. Frame ids are human-readable
  kebab-case derived from purpose (`login`, `settings-billing`).
- No decorative spotlight. The dimming effect responds only to hover or focus,
  never as a default resting state of the canvas.

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
- [ ] A tap enters a frame and stays entered — no flash back to overview. A
      drag pans from every surface — overview frames, frame labels, and a
      focused frame's text alike — and never selects page text; a press on a
      focused frame's real controls stays with the control (editable fields
      keep caret and selection); space-drag still pans; focus + `Escape`
      round-trips. Collapsed note chips toggle from keyboard and assistive
      click, not only from a pointer tap.
- [ ] 640px degrades to the stacked read; content fully reachable and text
      selectable, no pinch required, zoom cluster hidden.
- [ ] In-memory state only (no `localStorage`); no external requests.

**Canvas fluid-interaction addendum** (all items P0 when included):
- [ ] Flick-to-glide decays naturally and a mid-flight grab stops it with no
      jump (interruptible, per `motion.md`).
- [ ] Over-scroll shows rubber-band resistance; releasing snaps back.
- [ ] Pinch-to-zoom tracks two pointers, respects MIN/MAX with rubber-band,
      and shares the same clamp as ctrl+wheel.
- [ ] Double-click zooms in at the pointer; Shift+double-click zooms out.
- [ ] Tour steps follow `data-tour` order with camera animation, "n / N"
      progress, and Escape returns to overview. Tour order reads as spatial
      travel (adjacent steps are neighbors or connected).
- [ ] Hover or focus on a frame lights it and its connected neighbors;
      everything else dims. Moving away clears spotlight.
- [ ] `#frame-id` in the URL focuses that frame on load. Clicking or
      focusing a frame updates the hash via replaceState. Overview clears it.
- [ ] `prefers-reduced-motion` collapses all physics and camera tweens to
      instant, without locking input.
- [ ] Keyboard-only: all features reachable (tour arrows, zoom shortcuts,
      frame focus via Tab, Escape to overview).
