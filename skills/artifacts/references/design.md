# Designing artifact pages

Approach each page as a designer would: deliberate palette, typography, and
layout choices specific to the subject — never a templated default.

## Calibrate the treatment

A plan, memo, or report wants a utilitarian treatment: real typographic
hierarchy, considered spacing, a proper palette, no giant hero. A landing
page, game, or tool the user will keep or share can take an editorial
treatment with a stronger point of view. When unsure, a well-composed quiet
page is never wrong; an over-designed one sometimes is.

## Fundamentals

- **Honor what exists.** If the project has a design system (tokens, theme
  files, component styles), apply it. Precedence: the user's words, then the
  project's system, then your choices.
- **Ground it in the subject.** Build with real content, never lorem ipsum.
  Distinctive choices come from the subject's own world.
- **Typography carries the page.** The CSP blocks font CDNs — use system
  stacks or inline a face as a `@font-face` data URI. Keep running text near
  65ch, set a type scale and stay on it, give headings `text-wrap: balance`,
  use `font-variant-numeric: tabular-nums` where digits align.
- **Choose neutrals deliberately.** A grey with a slight hue bias toward the
  accent reads as chosen; pure mid-grey reads as unconsidered.
- **Let layout do the spacing.** Flex/grid with `gap`, not per-element
  margins that collapse. Wide content (tables, code, diagrams) scrolls inside
  its own `overflow-x: auto` container — the body never scrolls sideways.
- **Avoid the AI-generated look.** Warm cream + serif + terracotta; near-black
  with one acid accent; purple-to-blue gradient heroes; emoji as section
  markers; everything centered; rounded cards with accent rails. If the user
  asks for one of these, follow exactly; otherwise spend your freedom
  elsewhere.
- **Build cleanly.** Close every element, double-quote attributes, visible
  keyboard focus, respect `prefers-reduced-motion`, watch selector
  specificity fights.
- **Copy is design material.** Name things by what readers recognize; active
  voice; controls say exactly what happens; errors explain the fix.
- **Structure encodes information.** Numbered markers only for real
  sequences; dividers and labels only where they say something true.
- **Dashboards are operated, not read.** Summary before detail; encode state
  in form (pill, chip, severity stripe) as well as number; semantic
  good/warning/critical color is separate from the accent.

## Hard constraints (will break the page if ignored)

- No external requests of any kind — inline everything, `data:` URIs for
  images and fonts.
- No localStorage/sessionStorage/cookies — in-memory state only.
- Both themes must work: `@media (prefers-color-scheme: dark)` plus
  `:root[data-theme="dark"]` and `:root[data-theme="light"]` overrides.
- A `<title>` tag names the artifact.
- Write body content only — the server wraps it in doctype/head/body with a
  minimal reset. A `<style>` block at the top of your content is fine.

## Process

Before writing code, sketch a compact plan: 4-6 named hex values, type roles
(display/body/utility), and a one-sentence layout concept. Then build from
that plan, deriving every color and type decision from it.
