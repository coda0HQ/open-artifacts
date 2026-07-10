---
name: using-open-artifacts
description: Publish self-contained HTML/Markdown pages as shareable artifacts on a self-hosted Open Artifacts instance, update them at the same URL, protect them with client-side password encryption, and keep them fresh when their source files change. Use when the user asks to publish, share, or update an artifact, report, dashboard, or page ("share this as a page", "publish an artifact", "make me a link", "password-protect this", "分享成网页", "发布 artifact"), or when `.artifacts/manifest.json` exists and project files changed.
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

State lives in `.artifacts/`: `manifest.json` (committed, shared with
teammates) and `credentials.json` (gitignored). For artifacts you want to
keep machine-private, pass `--local` — the entry goes into
`manifest.local.json`, which the CLI gitignores; reads merge the two (local
overrides non-local, mirroring Claude Code's `settings.local.json`).
Credentials always live in the single `credentials.json`. On the **first
`create` in a project**, ask the user whether the artifact should be local;
**recommend local** (machine-private by default) and pass `--local` when
they say yes.

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

Publishing or republishing an artifact means reading project resources,
reading this skill's design references, writing (or rewriting) a full HTML
file, and running the CLI. All of that is context a parent conversation
doesn't need to keep — it only needs the resulting URL and a one-line
summary.

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
  what must not change. (For an encrypted artifact, `show` decrypts locally
  with the password stored at create time in `credentials.json`, so the
  plaintext is recovered without re-prompting the user.) It then reads the
  project files the artifact's `scope` covers and regenerates the page.
  `update <id> <file>` requires the regenerated file path (no local source
  copy is kept — the server is the source of truth).
- Any explicit flags the user gave: `--scope`, `--channel`, `--watch`,
  `--level`, `--canvas`, `--password`, `--description`, `--local`.

The sub-agent does the entire rest of the workflow itself — explore
resources, plan, read `${CLAUDE_SKILL_DIR}/references/design.md` and
friends, write the page to a temp file, run `create`/`update`, delete the
temp file, verify — and returns **only** a short summary: the URL, the
version number, and one line on what changed. The parent relays that to the
user. It must not read the generated HTML, run `create`/`update` itself, or
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
familiarity vs distinctiveness), the anti-AI-slop bans, a shared token
contract (`${CLAUDE_SKILL_DIR}/references/tokens.css` — paste it into your
`<style>` first, then override identity tokens per direction), an
installed-font specimen library (the CSP blocks *downloading* fonts, not the
OS library — Iowan, Charter, Avenir, Optima and friends are available), a
5-direction library (Editorial / Modern minimal / Human / Tech utility /
Brutalist) with ready-to-paste OKLch palettes, guidance for visual material
under the CSP (SVG charts/diagrams/typographic set-pieces instead of
text-only slabs), a component contract written against tokens, the viewer
frame specifics (sticky header height, theme stamping), and the ship gate
run before every publish.

### Production level (1 / 2 / 3)

Every artifact is built at one of three levels — pick implicitly from the
brief, or override with `--level 1|2|3` (aliases `--simple` /
`--interactive` / `--rich`):

- **Level 1 — simple:** typography-led documents (reports, articles, API
  references, notes). No flashy hero, minimal JS. Default for "read once"
  content.
- **Level 2 — interactive:** dashboards, docs sites, demos, prototypes.
  Stateful in-memory JS, navigation, copy buttons, expandable sections,
  subtle transitions. Default when unsure. Before building L2+, read
  `${CLAUDE_SKILL_DIR}/references/interaction.md` for the eight-state
  contract, focus visibility, hit targets, form patterns, and waiting states.
- **Level 3 — rich:** landing/marketing pages, product showcases. Orchestrated
  motion — load sequences, scroll reveals, view transitions — **all native
  browser APIs, no external libraries** (the strict CSP blocks CDNs). Read
  `${CLAUDE_SKILL_DIR}/references/motion.md` for the native motion pattern
  library before building L3 (`interaction.md` applies here too).

Don't gold-plate a doc as L3; don't ship a landing page as L1. The level
sets the component contract and motion budget, not just "how much
animation."

### Canvas mode (--canvas)

Orthogonal to level: `--canvas` swaps the page *shell* — an infinite spatial
plane of pan/zoom **frames** instead of a scrolling document — while `--level`
keeps meaning fidelity and motion budget. It composes with any level:
`--level 1 --canvas` is spatial notes, `--level 2 --canvas` a multi-frame
prototype (the default use), `--level 3 --canvas` a canvas-as-showcase. Read
`${CLAUDE_SKILL_DIR}/references/canvas.md` before building one -- it has the
complete vendored runtime (CSS + vanilla JS) with momentum and pinch physics,
an optional presenter tour, connector spotlighting, and `#frame-id` deep
links, plus the frame and freeform contracts and a canvas ship-gate.

## Authoring content — hard constraints

The strict CSP blocks ALL external requests (CDN scripts, fonts, remote
images, fetch/XHR/WebSockets):

- Inline all CSS and JS; embed images and fonts as `data:` URIs. Use system
  font stacks or inline a face as a `@font-face` data URI.
- **Icons: prefer [Remix Icon](https://remixicon.com/).** Read
  `${CLAUDE_SKILL_DIR}/references/icons.md` for a vendored ~90-icon inline-SVG
  subset (navigation, actions, status, social, common UI). Copy the whole
  `<svg>` block inline — it uses `fill="currentColor"` so it inherits color.
  Never link the Remix Icon CDN (the CSP blocks it); only inline SVGs.
- Do not use localStorage/sessionStorage (the sandbox blocks them); keep
  state in memory.
- Include a concise `<title>` — it becomes the artifact title.
- Support both themes: paste the token contract (`references/tokens.css`) —
  it handles OS preference and the viewer's `data-theme` stamping via
  `@layer`. Your direction override goes below it, unlayered: a `:root`
  block (light) plus a `:root[data-theme="dark"]` block, both mandatory.
- Responsive: no horizontal body scroll; wide tables/code get their own
  `overflow-x: auto` container.
- Markdown files (`.md`) are rendered client-side; HTML is best for anything
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

Write the page to a temp file (e.g. `$(mktemp).html` or a scratch path in
the OS temp dir — the server is the source of truth, so no local source
copy is kept), then pass that path to `create`:

```
node artifact.mjs create /tmp/app-interactions.html --favicon 📊 \
  --scope "user-facing interaction flows of the app" \
  --channel app-interactions \
  --watch "src/views/**,src/components/**" \
  --description "One-sentence subtitle"
```

- `--favicon`: required, one or two emoji. Keep it STABLE across updates.
- `--scope`: what the artifact is about, in one sentence. Required for any
  artifact derived from project files — it drives auto-updates later.
- `--channel <slug>`: bind this artifact to a **stable URL**. Reusing the
  same slug on a later `create` updates the same link (new version, no new
  URL) — so "the app-interactions page" always lives at one link, even
  across sessions or machines. Use a kebab-case slug that names the topic.
  Without `--channel`, each `create` mints a new URL (use `update <id>` to
  update those).
- `--watch`: comma-separated globs of the source files the artifact was
  derived from.
- `--local`: write the manifest entry to `.artifacts/manifest.local.json`
  (gitignored, machine-local) instead of the committed manifest. Reads
  merge the two (local overrides). On the **first create in a project**,
  ask the user whether this artifact should be local — **recommend local**
  (machine-private by default); pass `--local` when they say yes.
  Credentials always go to the single gitignored `credentials.json`
  regardless of this flag.
- Prints the shareable URL on stdout. Give it to the user.

The command records the artifact in `.artifacts/manifest.json` (commit
this) — or `manifest.local.json` with `--local` (gitignored) — and its
tokens in `.artifacts/credentials.json` (auto-gitignored, never commit or
print tokens). The channel token (`ch_`) also lives in credentials; the
slug in the manifest is safe to commit.

## Updating

*(Run this inside the isolated sub-agent — see "Isolate content generation
in a sub-agent" above.)*

```
node artifact.mjs update <id> <file> [--label "what-changed"]
```

Same URL, new version. `<file>` is **required** — the sub-agent regenerates
the page first: read the current published version as the starting reference
with `node artifact.mjs show <id>` (prints the stored content; for an
encrypted artifact it decrypts locally using the password stored at create
time, so a locked design direction's comment at the top of the page is
recovered), read the project files the artifact's `scope` covers,
regenerate, write to a temp file, and pass it here. The manifest supplies
the write token and expected version; on a version conflict the CLI
explains and offers `--force`. `node artifact.mjs list` shows known
artifacts.

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
node artifact.mjs create page.html --favicon 🔒 --title "Q3 Numbers" --password "..."
```

Content is encrypted locally (PBKDF2 600k + AES-256-GCM); the server stores
only ciphertext and viewers decrypt in the browser. Share the URL and the
password through different channels. The password is stored in
`.artifacts/credentials.json` (gitignored, machine-local) at create time so
later `update` and `show` can decrypt without re-prompting the user — pass
`--password` again only to rotate it. `delete` clears the stored password
too. Note: the title and favicon are stored in plaintext as metadata —
keep them non-sensitive.

## Reading back

`GET <instance>/api/artifacts/<id>` returns metadata and version history;
`GET <instance>/api/artifacts/<id>/raw` returns the stored content
(`?v=N` for older versions). For a non-encrypted artifact that is the page
itself (`text/plain`); for an encrypted artifact it is a JSON ciphertext
envelope — run `node artifact.mjs show <id>` instead, which decrypts locally
using the password stored at create time. Viewer URLs also accept `?v=N`.
