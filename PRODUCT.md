# PRODUCT.md — Open Artifacts

## Register

product — the surfaces under design are tool UI (the artifact viewer chrome, the
canvas runtime's zoom cluster / note chips / frame labels). Design serves the
task; the bar is earned familiarity (Figma / Linear-grade viewer chrome), not
distinctiveness. Individual artifacts may be brand-register pages, but they own
their register per `skills/using-open-artifacts/references/design.md`.

## Who / What / Why

- **Users**: developers whose coding agents publish self-contained HTML pages
  (reports, dashboards, prototypes, canvas boards) to shareable URLs.
- **Product**: a self-hosted Claude Code Artifacts clone — an agent skill + a
  Cloudflare Worker (D1 + R2). The skill authors pages; the Worker wraps them in
  a sandboxed viewer (strict CSP, opaque origin, theme toggle, sticky header).
- **Outcome**: the viewer chrome and vendored runtimes must disappear into the
  task — pan/zoom that feels like Figma, controls a Linear user trusts on sight.

## Brand personality (for the chrome)

Quiet, precise, systems-grade. One accent (`--accent`), restrained color
strategy, tokens from `skills/using-open-artifacts/references/tokens.css`.
References: Figma's canvas chrome, Linear's toolbar restraint.

## Anti-references

- Decorative motion, orchestrated load sequences (users are mid-task).
- Over-decorated controls, invented affordances for standard tasks.
- The AI-slop tropes already banned in `references/design.md` (side-stripes,
  gradient text, hero metrics, eyebrow-per-section).

## Strategic design principles

1. **The runtime is the design system.** Fixes land in
   `skills/using-open-artifacts/references/canvas.md` (and friends), never as
   per-artifact patches — every future artifact inherits them.
2. **Both themes always** — the viewer stamps `data-theme`; every chrome
   element must read in light and dark.
3. **Keyboard is a first-class pointer** — chips, labels, and cluster buttons
   are focusable with visible rings; keyboard actions jump instantly (no
   animation on high-frequency actions).
4. **Constraints are law**: strict CSP (inline-only, no external requests),
   opaque origin (no storage), `LAYOUT_SCRIPT` rewrites sticky tops (floating
   chrome is `position: fixed`).
