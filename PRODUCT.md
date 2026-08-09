# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers whose coding agents publish self-contained HTML/Markdown pages -
reports, dashboards, prototypes, canvas boards - to shareable URLs. The engine's
canonical deployment is a hosted SaaS whose primary users are small teams
managing agent-published artifacts. Self-hosters running the engine on their own
Cloudflare account are a secondary audience.

## Product Purpose

Open Artifacts is the open-source engine that powers a hosted account-based
platform. An agent skill authors self-contained HTML/Markdown pages; a Cloudflare
Worker (Hono + D1 + R2) stores them and serves them in a sandboxed viewer with
strict CSP and an opaque origin. Success means the engine runs a canonical hosted
instance and remains freely self-hostable (MIT) for anyone who wants their own.

## Positioning

Open Artifacts is the engine beneath a hosted account-based platform: an agent
skill + Cloudflare Worker that turns coding-agent output into shareable,
sandboxed, in-sync pages. A hosted instance is the canonical deployment; the
engine is self-hostable (MIT) as a secondary capability, not the headline. The
hosted platform is the product; Open Artifacts is the foundation - messaging
should not lead with self-host parity.

## Operating Context

- The engine is consumed by a hosted SaaS via `file:../open-artifacts`; the host
  layer adds accounts, orgs, visibility, and branding via `BRAND_*` vars and a
  pluggable authorizer (the host supplies its own).
- Self-hosting: deploy the Worker through the gated workflow (MIT). Numbered D1
  migrations run before application promotion; requests only validate schema
  compatibility. Local dev state lives in `.wrangler/state`.
- Agents publish via the Open Artifacts skill/CLI (`npx skills add`), pointing
  `OPEN_ARTIFACTS_URL` at an instance (hosted or self-hosted).
- Bindings: D1 (`DB`), R2 (`CONTENT`), assets and metrics; optional `LIVE_DO`
  (Live Draft/Checkpoint), `OPEN_ARTIFACTS_HANDOFF` (handoff recording), and
  explicit create/comment/rate policies.
- Viewer: `sandbox allow-scripts; default-src 'none'`, opaque origin - no
  external requests, no storage, no `fetch`; viewer-side data is inlined at serve
  time. Max artifact content 4 MiB (`MAX_CONTENT_MIB` override).
- Two typecheck/test targets: `tsconfig.json` + `tests/worker/` (Worker,
  cloudflare pool) and `tsconfig.cli.json` + `tests/cli/` (skill CLI, node).
- `skills/using-open-artifacts/` is a published agent skill (own SKILL.md,
  scripts/, references/, examples/) - treat as a published package, not scratch.

## Capabilities and Constraints

- Engine: Hono + D1 + R2 Cloudflare Worker; agent skill authors self-contained
  HTML/Markdown pages.
- Sandboxed viewer: strict CSP, opaque origin, no external requests/storage;
  viewer-side data is inlined at serve time (runtime fetch is impossible).
- Password-protected, zero-knowledge client-side-encrypted artifacts.
- Optional deploy-time features: `LIVE_DO` Durable Object (live variant editing
  over WebSocket), `OPEN_ARTIFACTS_HANDOFF` (webcam + interaction handoff
  recording), `CREATE_TOKEN` (open instance when absent).
- Engine is brand-neutral; the host layer supplies branding and the authorizer.
- Composition root: `createApp(authorizer)` accepts a pluggable authorizer;
  account/org/visibility tables never live in the engine.
- Max artifact 4 MiB default (`MAX_CONTENT_MIB` override).

## Brand Commitments

- Name: Open Artifacts (the engine); a hosted product built on it carries its own
  identity.
- The viewer chrome is quiet, precise, systems-grade - one accent (`--accent`),
  restrained color, tokens from `skills/using-open-artifacts/references/tokens.css`.
  References: Figma's canvas chrome, Linear's toolbar restraint. This register is
  preserved for the chrome and is distinct from the hosted product's landing world.
- Engine is MIT-licensed and open-source.
- Register: the surfaces under design are tool UI (artifact viewer chrome, canvas
  runtime zoom cluster / note chips / frame labels). Design serves the task; the
  bar is earned familiarity, not distinctiveness. Individual artifacts may be
  brand-register pages but own their register per
  `skills/using-open-artifacts/references/design.md`.
- Anti-references (chrome): decorative motion / orchestrated load sequences
  (users are mid-task); over-decorated controls or invented affordances for
  standard tasks; decorative spotlight or resting "cinema" dim on the canvas
  (spotlight only on hover/focus of a frame, per `references/canvas.md`); invented
  pan/zoom UI (compass, orbit, novel metaphors - stick to +/−/%/fit, drag,
  Space-drag, wheel/pinch, keyboard); the AI-slop tropes banned in
  `references/design.md` (side-stripes, gradient text, hero metrics,
  eyebrow-per-section).

## Evidence on Hand

- This repo (`src/`) plus the agent skill at `skills/using-open-artifacts/`
  (SKILL.md, references/, scripts/, examples/).
- The hosted product built on the engine carries its own PRODUCT.md and DESIGN.md
  in its own repo; this engine doc does not duplicate them.
- README documents purpose, deployment, and the agent skill.
- No fabricated metrics, testimonials, or customer claims - future work must not
  invent them.

## Product Principles

1. **The hosted platform is the product; the engine is the foundation.** The
   engine powers a canonical hosted instance; self-hosting (MIT) stays possible as
   a secondary capability, not the headline.
2. **The runtime is the design system.** Fixes land in
   `skills/using-open-artifacts/references/canvas.md` (and friends), never as
   per-artifact patches - every future artifact inherits them.
3. **Both themes always** - the viewer stamps `data-theme`; every chrome element
   must read in light and dark.
4. **Keyboard is a first-class pointer** - chips, labels, and cluster buttons are
   focusable with visible rings; keyboard actions jump instantly (no animation on
   high-frequency actions).
5. **Constraints are law** - strict CSP (inline-only, no external requests),
   opaque origin (no storage), `LAYOUT_SCRIPT` rewrites sticky tops (floating
   chrome is `position: fixed`).

## Accessibility & Inclusion

No product-specific accessibility standard is established. The viewer chrome
defaults to keyboard-first interaction, visible focus rings, and both-theme
contrast; future work should meet standard web accessibility until a specific
standard such as WCAG 2.2 AA is confirmed.
