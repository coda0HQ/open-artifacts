---
name: using-open-artifacts
description: "Use this skill when the user has finished something — a writeup, report, prototype, dashboard, data analysis, or markdown doc — and wants it turned into a web page with a shareable URL they can send to other people. The page is mobile-responsive, supports light/dark themes and optional password protection, keeps one URL across edits, and auto-refreshes when its source files change. Trigger on any phrasing where the real goal is a shareable link or page to give someone: \"make this into a page I can send a link to\", \"turn this writeup into a link\", \"publish this as a web page\", \"turn this data analysis into a shareable link\", \"make a web page I can send to others\", \"create an artifact to share with the team\", or when `.artifacts/manifest.json` exists and project files changed. Do NOT trigger for generic file uploads, image screenshots, or unrelated senses of \"artifact\" (SBOM scans, build tarballs, Linear tracking items, Claude API content blocks)."
---

# Artifacts

Publish a rendered web page the user can share by URL. The page is served with
a strict sandboxing CSP, wrapped in a skeleton with a CSS reset, an emoji
favicon, and light/dark theme support. Artifacts keep a stable URL across
updates and a full version history.

The publishing CLI lives at `${CLAUDE_SKILL_DIR}/scripts/artifact.mjs`
(referred to as `artifact.mjs` below). Run it with `node`.

## Setup (once per project)

The CLI needs an instance URL, resolved in this order: `--api` flag,
`OPEN_ARTIFACTS_URL` env var, `.artifacts/config.json` (`{"apiUrl": "..."}`),
`~/.config/open-artifacts/config.json`. If none is set, ask the user for their
instance URL and write `.artifacts/config.json`. If the instance requires a
create token, put it in `OPEN_ARTIFACTS_TOKEN` or `config.json` `createToken`.

Every artifact is built from a JSON Recipe plus ordered fragments. Read
`${CLAUDE_SKILL_DIR}/references/recipe.md` before creating or updating one.
Shared Recipes and fragments are project sources and may be committed. Local
or encrypted sources live under `.artifacts/recipes.local/` and
`.artifacts/fragments.local/`.

State lives in `.artifacts/`: Manifest v2 records only publication state and
build hashes; `credentials.json`, local manifests, private Recipes/fragments,
and previews are gitignored. On the **first `create` in a project**, ask
whether the artifact should be local and **recommend local**. Record the
choice in `artifact.local` and place the Recipe/fragments accordingly.

If the user has no instance yet, point them at
`${CLAUDE_SKILL_DIR}/references/deployment.md` — it has the three ways to get
one (use the public shared instance with zero setup, self-host on their own
Cloudflare account, or share a team instance) and a trust-model table to help
them choose based on content sensitivity. Don't deploy on their behalf unless
they ask.



## When to publish an artifact

Publish when the user asks for something shareable or standalone: reports,
dashboards, documentation pages, visualizations, demos, long-form writeups.
Do not publish for short answers, code snippets, or content the user will
read once in the conversation. When unsure, answer inline and offer to
publish.

## Isolate content generation in a sub-agent

Publishing or republishing means reading project resources and design
references, authoring a Recipe and fragments, validating the deterministic
build, and running the CLI. All of that is context a parent conversation
doesn't need to keep.

**Both `create` (first publish) and `update` (republish) — and everything
in "How to design the page" that leads up to them — run inside an isolated
sub-agent, never inline in the parent conversation.** In Claude Code,
dispatch the Agent tool (a general-purpose agent is enough, no special type
needed); in another harness, use its equivalent sub-task primitive.

Give the sub-agent everything it needs to work alone, then let it work:

- The brief: what's being published or updated, for whom, and why.
- If updating: the artifact id. The sub-agent runs `node artifact.mjs show
  <id>` to read the current published version as its starting reference —
  for a locked design, the direction comment at the top of that page states
  what must not change. "Locked" means the **visual direction** (register,
  palette hue family, layout posture) must not change — it does **not** exempt
  the artifact from validation gates. A contrast or CSP check added after the
  original publish can retroactively fail a previously-passing token; the
  refresh must then nudge the offending token within the same hue (e.g. darken
  the light-theme `--accent` a few lightness steps) so the page passes the gate
  while staying visually the same direction. (For an encrypted artifact, `show`
  decrypts locally with the password stored at create time in
  `credentials.json`, so the plaintext is recovered without re-prompting the
  user.) It then reads the Recipe recorded in Manifest v2, its fragments, and
  the project files its `scope` covers.
- Any explicit publication requirements. Put title, description, favicon,
  scope, channel, watch globs, level, Canvas mode, locality, and auto-update
  in the Recipe. Keep passwords out of it.

The sub-agent does the entire rest of the workflow itself — explore
resources, plan, read `${CLAUDE_SKILL_DIR}/references/design.md`,
`${CLAUDE_SKILL_DIR}/references/recipe.md`, and relevant mode references;
write the Recipe and fragments; run `validate`; optionally build a preview;
run `create`/`update`; verify; and return **only** a short summary: the URL,
version number, and one line on what changed. The parent relays that to the
user. It must not read generated output, run `create`/`update` itself, or
carry the design reasoning in its own context.

The lightweight bookkeeping commands — `status`, `ack <id>`,
`auto-update <id> on|off`, `list`, `install-hook` — don't touch content and
are fine to run directly in the parent conversation; only `create` and
`update` need isolation.

## How to design the page

You are an expert designer producing design artifacts in HTML. **HTML is your
tool, not your medium**: when the brief is a dashboard, be an information
designer; when it's a report, be an editorial designer; when it's a
prototype, be an interaction designer. Don't default to "a web page"
treatment for everything.

Workflow: (1) understand the brief — output kind, fidelity, audience, any
brand/design system; (2) explore resources — if the project has a design
system (tokens, theme, component styles), read it fully and apply it;
precedence is the user's words, then the project's system, then your choices;
(3) plan out loud — a one-line design read ("Reading this as: X for Y, in a
Z direction"), the scene sentence that picks light vs dark, 4–6 named
palette values, type roles, a one-sentence layout concept; (4) build with
real content, never lorem ipsum; (5) run the ship gate from `design.md`
once at the end — structural grep, the P0 checklist (contrast in both
themes, 360px, banned tropes, states, reduced motion, copy audit), then the
five-dimension critique (philosophy / hierarchy / execution / specificity /
restraint) — fix anything under 3/5, re-score once, publish. Do not loop on
renders.

**Read `${CLAUDE_SKILL_DIR}/references/design.md` before writing a page.** It
has the full design philosophy: the brand-vs-product register split (earned
familiarity vs distinctiveness), the anti-AI-slop bans, the shared token
contract (`${CLAUDE_SKILL_DIR}/references/tokens.css`, injected by the Recipe
builder; override identity tokens in the theme fragment), an
installed-font specimen library (the CSP blocks *downloading* fonts, not the
OS library — Iowan, Charter, Avenir, Optima and friends are available), a
5-direction library (Editorial / Modern minimal / Human / Tech utility /
Brutalist) with ready-to-paste OKLch palettes, guidance for visual material
under the CSP (SVG charts/diagrams/typographic set-pieces instead of
text-only slabs), a component contract written against tokens, the viewer
frame specifics (sticky header height, theme stamping), and the ship gate
run before every publish.

### Production level (1 / 2 / 3)

Every artifact is built at one of three levels. Pick from the brief and record
it as `artifact.level: 1|2|3` in the Recipe:

- **Level 1 — simple:** typography-led documents (reports, articles, API
  references, notes). No flashy hero, minimal JS. Default for "read once"
  content. Wrap the body in `<main class="oa-prose">` — the contract's prose
  baseline (measure cap, padding, heading/code styling) — so a doc that
  defines tokens but forgets structure does not ship bare.
- **Level 2 — interactive:** dashboards, docs sites, demos, prototypes.
  Stateful in-memory JS, navigation, copy buttons, expandable sections,
  subtle transitions. Default when unsure **and the brief is interactive** —
  if the brief is mostly text to read, level 1 is the safer pick (it carries a
  structure baseline; L2's structure is author-supplied). Before building L2+,
  read `${CLAUDE_SKILL_DIR}/references/interaction.md` for the eight-state
  contract, focus visibility, hit targets, form patterns, and waiting states.
- **Level 3 — rich:** landing/marketing pages, product showcases. Orchestrated
  motion — load sequences, scroll reveals, view transitions — **all native
  browser APIs, no external libraries** (the strict CSP blocks CDNs). Read
  `${CLAUDE_SKILL_DIR}/references/motion.md` for the native motion pattern
  library before building L3 (`interaction.md` applies here too).

Don't gold-plate a doc as L3; don't ship a landing page as L1. The level
sets the component contract and motion budget, not just "how much
animation."

### Canvas mode

Orthogonal to level, `artifact.canvas: true` swaps the page *shell* for an
infinite spatial plane of pan/zoom **frames**. It composes with any level:
level 1 is spatial notes, level 2 a multi-frame prototype (the default use),
and level 3 a canvas-as-showcase. Read
`${CLAUDE_SKILL_DIR}/references/canvas.md` before building one -- it has the
complete vendored runtime (CSS + vanilla JS) with momentum and pinch physics,
an optional presenter tour, connector spotlighting, and `#frame-id` deep
links, plus the frame and freeform contracts and a canvas ship-gate.

## Authoring content — hard constraints

The strict CSP blocks ALL external requests (CDN scripts, fonts, remote
images, fetch/XHR/WebSockets):

- Inline all CSS and JS; embed images and fonts as `data:` URIs. Use system
  font stacks or inline a face as a `@font-face` data URI. On a deploy that set
  `OPEN_ARTIFACTS_WEB_FONTS="1"`, a web font may also be loaded same-origin via
  the `/fonts/<family>--<weight>[--italic]` proxy or directly from an allowlisted
  font CDN (Fontshare / Google Fonts), and mermaid via an allowlisted
  `<script src="/vendor/mermaid.runtime.js">` (a regular, non-module script)
  served same-origin —
  see `references/fonts.md` and `references/scripts.md`. The build gate restricts
  `@font-face`/`@import` to those font hosts and `<script src>` to the
  allowlisted same-origin `/vendor/...` bundle, so no arbitrary external host is
  ever reachable.
- **Icons: prefer [Remix Icon](https://remixicon.com/).** Read
  `${CLAUDE_SKILL_DIR}/references/icons.md` for a vendored ~90-icon inline-SVG
  subset (navigation, actions, status, social, common UI). Copy the whole
  `<svg>` block inline — it uses `fill="currentColor"` so it inherits color.
  Never link the Remix Icon CDN (the CSP blocks it); only inline SVGs. To sit
  an icon next to text, wrap them in the contract's centered row
  (`<h2 class="oa-ico-text"><svg class="oa-ico">…</svg> Title</h2>`) — a bare
  icon in a heading sits low and the build fails it.
- Do not use localStorage/sessionStorage (the sandbox blocks them); keep
  state in memory.
- Put the concise title in `artifact.title`.
- Support both themes. The builder injects `references/tokens.css`; author a
  theme fragment with an unlayered `:root` block (light) plus a
  `:root[data-theme="dark"]` block, both mandatory. The token contract only
  supplies *variables* — it does not style your elements. For a level 1 HTML
  document, wrap the body in `<main class="oa-prose">` to pick up the prose
  baseline (measure cap, page padding, heading scale, `code`/`pre`/`table`
  styling) the contract ships. `validate` fails an L1 non-canvas page with no
  measure cap, since the default is a full-width doc with browser-default
  spacing. Markdown needs nothing — the viewer wraps it in `.oa-md`
  automatically. The viewer chrome (service header, theme toggle, brand chip,
  focus ring) is injected by the harness at serve time — never hand-author it.
  It follows your identity palette automatically via the token contract's
  chrome bridge, so do **not** override `--oa-*` viewer tokens in the theme
  fragment. L2/L3 may be full-bleed by design; author their structure
  explicitly.
- Responsive: no horizontal body scroll; wide tables/code get their own
  `overflow-x: auto` container.

### Authoring Markdown

Most of the hard constraints above are **HTML-specific and do not apply to
Markdown**. A Markdown Recipe publishes the body `.md` **verbatim** — the
builder does not inject `references/tokens.css`, does not wrap the content in
a `<style>` block, and runs none of the HTML validation gates (no theme
fragment, no `:root`/`[data-theme="dark"]` requirement, no contrast check, no
L1 measure-cap, no banned-trope grep). The viewer wraps the raw Markdown in
`.oa-md` and renders it client-side with the viewer's default tokens, so:

- `document.theme`, `document.fragments.theme`/`styles`/`scripts` must all
  be **omitted** — `validate` *rejects* a Markdown Recipe that carries a
  theme/styles/scripts fragment (error: "Markdown recipes only support body
  fragments"). Supply `document.fragments.body` with one or more `.md` files
  only; `document.theme` may be omitted or `null`.
- You cannot theme, style, or script a Markdown artifact; if you need
  interaction, identity tokens, or a measure cap beyond the default, author it
  as HTML instead.
- `artifact.title` still drives the page title and OG card; the first `#`
  heading is also extracted as a fallback title.
- Both-themes support is automatic (the viewer's `.oa-md` shell reads light/dark
  tokens); nothing for you to author.

Markdown files (`.md`) are rendered client-side; HTML is best for anything
interactive or designed.

**Avoid AI-slop tropes** (`design.md` has the full match-and-refuse list):
side-stripe accent borders, gradient text (`background-clip: text`), decorative
glassmorphism, identical card grids, the hero-metric template, icon-tile stacks
(rounded-corner icon tiles floating above every card heading), an uppercase
eyebrow or `01 / 02 / 03` marker above every section, colored glow shadows on
dark backgrounds, italic-serif display heroes, aphoristic copy cadence ("Not X.
Y."), headings that overflow at mobile width, and invented content -- no fake
metrics, testimonials, or "Acme Corp"; an honest placeholder beats a fake stat. Verify contrast (body
≥ 4.5:1 in both themes) and never ship muted gray on a tinted near-white.
Full-viewport sections use `min-height: calc(100dvh - var(--oa-header-h,
2.5rem))` — the viewer adds a sticky header. Modern CSS is fully available
inline — `text-wrap: pretty/balance`, CSS Grid, container queries,
`color-mix()`, `:has()`, view transitions, `clamp()` for fluid type.

## Publishing

*(Run this inside the isolated sub-agent — see "Isolate content generation
in a sub-agent" above.)*

Create a Recipe and ordered fragments, validate them, then publish:

```
node artifact.mjs validate artifacts/app-interactions.recipe.json
node artifact.mjs create artifacts/app-interactions.recipe.json
```

The Recipe owns favicon, scope, channel, watch globs, level, Canvas mode,
locality, and auto-update. Keep the favicon stable. Use a kebab-case channel
to reuse one URL across `create` calls; use `null` to mint a new URL. `create`
composes in memory and sends one final payload. It prints the shareable URL.

Manifest v2 records the Recipe path and Recipe/input/output hashes only after
the publish succeeds. Write tokens and channel tokens remain in the
gitignored credentials file.

## Updating

*(Run this inside the isolated sub-agent — see "Isolate content generation
in a sub-agent" above.)*

```
node artifact.mjs update <id> [recipe.json] [--label "what-changed"]
```

Same URL, new version. Without a path, `update` uses the Recipe recorded in
Manifest v2. Update its fragments after reading project sources and, when
useful, compare with `show <id>`. The CLI rebuilds and validates in memory,
then publishes once. A legacy Manifest v1 entry is migrated to Recipe sources
when first updated. On a version conflict, review it before using `--force`.
`list` shows known artifacts.

## Keeping artifacts fresh (do this without being asked)

After the first `create` in a project, **ask the user** whether to install the
staleness Stop hook — don't install it silently. If they agree, run
`node artifact.mjs install-hook` (adds a `Stop` hook to `.claude/settings.json`
that surfaces drift at the end of every turn). With the hook installed, at the
end of a turn whose changes touched an artifact's watched files you are told
which artifact drifted and why. Either way, you can check on demand:

```
node artifact.mjs status
```

For each artifact reported stale, decide whether the changed files affect its
recorded scope:

- **They affect it** → regenerate the page content to reflect the current state
  of the project and run `update`. That republishes and refreshes the snapshot.
  Regenerating is content generation, so dispatch it to a sub-agent per
  "Isolate content generation in a sub-agent" above — including when this
  judgment call is made autonomously via the Stop hook, not just when a
  human asks directly.
- **They don't** (e.g. a refactor with no behavior change for a user-facing
  scope, or a design direction locked in the scope) → run
  `node artifact.mjs ack <id>`. This advances the snapshot baseline offline —
  no republish — so the same unrelated change stops being reported every turn.
  `ack` is a pure manifest mutation, not content generation, so it's fine to
  run directly. Don't just leave it stale: with the hook installed it
  re-nudges on every future turn until the baseline moves via `update` or
  `ack`.

### Opting a specific artifact into the automatic loop

By default, the Stop hook (once installed) surfaces **every** stale, watched
artifact — the regenerate-vs-`ack` judgment above still applies to each one,
unchanged. If the user wants the hook to stay quiet about most artifacts and
only nudge about specific ones, turn on that artifact's auto-update flag:

```
node artifact.mjs auto-update <id> on
```

This does not change how you decide what to do once an artifact is flagged —
it only changes **which artifacts the Stop hook is allowed to flag at all**:

- Opt-in, per-artifact, and fully isolated: it flips one manifest entry's
  `autoUpdate` field and never reads or writes any other entry's state. Off
  by default — artifacts never toggled (or created before this feature) are
  treated as off, and the hook stays completely silent about them even
  while stale.
- A plain, human-run `node artifact.mjs status` (no `--hook`) is never
  filtered by this flag — it always reports every stale watched artifact.
  Only the autonomous, no-human-present Stop-hook path narrows to opted-in
  artifacts.
- Turning it **on** requires a write token to already exist for that artifact
  (fails clearly if not), and installs the Stop hook automatically if it
  isn't already present. Unlike `create`'s hook hint, which never installs
  anything for you, running `auto-update <id> on` *is* the user's consent to
  install it — go ahead, and the CLI prints a confirmation when it does.
- Turning it **off** (`node artifact.mjs auto-update <id> off`) leaves any
  installed hook in place; it just stops mentioning this artifact.

## Password protection

```
node artifact.mjs create .artifacts/recipes.local/q3.recipe.json --password "..."
```

Set `security.encrypted: true` and a kebab-case
`security.passwordCredential` in the Recipe. Encrypted Recipes and fragments
must use the private `.artifacts` source directories.

Content is encrypted locally (PBKDF2 600k + AES-256-GCM); the server stores
only ciphertext and viewers decrypt in the browser. Share the URL and the
password through different channels. The CLI resolves the named credential
from `--password`, its `OPEN_ARTIFACTS_PASSWORD_*` environment variable, or
the gitignored credentials file. Passwords never enter Recipes or Manifests.
Title and favicon remain plaintext service metadata, so keep them
non-sensitive.

## Reading back

Raw content lives under the **API path only** —
`GET <instance>/api/artifacts/<id>/raw`. The viewer path
`GET <instance>/a/<id>` serves the rendered viewer page (HTML), not the raw
bytes; `/a/<id>/raw` is not a route and returns 404. Don't confuse the two:
`/a/<id>` = the page a browser renders, `/api/artifacts/<id>/raw` = the stored
content as published.

`GET <instance>/api/artifacts/<id>` returns metadata and version history;
`GET <instance>/api/artifacts/<id>/raw` returns the stored content
(`?v=N` for older versions). For a non-encrypted artifact that is the page
itself (`text/plain`); for an encrypted artifact it is a JSON ciphertext
envelope — run `node artifact.mjs show <id>` instead, which decrypts locally
using the password stored at create time. Viewer URLs also accept `?v=N`.

## Project-change feedback

A viewer can send a note asking for a change to the **source project** behind
an artifact (not to the page's wording — that is a comment). The viewer submits
it from the host chrome; it is stored as an independent record and never
becomes a new artifact version. This is a pull channel: nothing notifies you,
so poll it.

```bash
node artifact.mjs feedback <id>                 # pending notes, oldest first
node artifact.mjs feedback <id> --status done   # a different status
node artifact.mjs feedback-ack <id> <fid> --status in_progress
node artifact.mjs feedback-rm <id> <fid>        # delete spam outright
```

Each poll line is `<feedback-id>  [status]  <createdAt>`, then the optional
source-project path and the note body.

Work a note like this: `feedback-ack ... --status in_progress` when you start
editing the project, then make the change in the **project files**, then
re-publish with `update` if the artifact's content is affected, then
`feedback-ack ... --status done`. Advancing to `done` is what drops it out of
the pending poll — it does not regenerate anything by itself, and closing a
note without a regen is a valid outcome (say so in the project, not the page).

All of these are owner-only and use the stored write token. Submission is open
to anonymous viewers on an instance with no `CREATE_TOKEN`, so a public
artifact's queue can collect spam — `feedback-rm` is how you drop it, since
`done` only hides a note from the pending poll. On a `CREATE_TOKEN`-gated
instance viewers hold no token, so the control is not rendered at all and the
queue stays empty.
