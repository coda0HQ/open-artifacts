---
name: artifacts
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

## When to publish an artifact

Publish when the user asks for something shareable or standalone: reports,
dashboards, documentation pages, visualizations, demos, long-form writeups.
Do not publish for short answers, code snippets, or content the user will
read once in the conversation. When unsure, answer inline and offer to
publish.

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
(3) plan — sketch 4–6 named palette values, type roles, a one-sentence
layout concept, and vocalize the system before building; (4) build with real
content, never lorem ipsum; (5) verify once at the end — re-read your own
output, `grep` for unclosed tags / dangling `<script>`, trace the main
interaction. Do not loop on renders.

**Read `${CLAUDE_SKILL_DIR}/references/design.md` before writing a page.** It
has the full design philosophy, the anti-AI-slop tropes to avoid, a
5-direction library (Editorial / Modern minimal / Human / Tech utility /
Brutalist) with ready-to-paste OKLch palettes and font stacks for when no
brand is specified, and the hard constraints below.

## Authoring content — hard constraints

The strict CSP blocks ALL external requests (CDN scripts, fonts, remote
images, fetch/XHR/WebSockets):

- Inline all CSS and JS; embed images and fonts as `data:` URIs. Use system
  font stacks or inline a face as a `@font-face` data URI.
- Do not use localStorage/sessionStorage (the sandbox blocks them); keep
  state in memory.
- Include a concise `<title>` — it becomes the artifact title.
- Support both themes: style with `@media (prefers-color-scheme: dark)` AND
  `:root[data-theme="dark"]` / `:root[data-theme="light"]` overrides (a theme
  toggle stamps `data-theme` on the root element and must win both ways).
- Responsive: no horizontal body scroll; wide tables/code get their own
  `overflow-x: auto` container.
- Markdown files (`.md`) are rendered client-side; HTML is best for anything
  interactive or designed.

**Avoid AI-slop tropes:** aggressive gradient backgrounds; gratuitous emoji;
rounded boxes with a left-border accent; SVG-as-illustration when a
placeholder would do; overused fonts (Inter, Roboto, Arial, Fraunces);
everything centered; `rounded-lg` everywhere. Modern CSS is fully available
inline — `text-wrap: pretty/balance`, CSS Grid, container queries,
`color-mix()`, `:has()`, view transitions, `clamp()` for fluid type.

## Publishing

```
node artifact.mjs create page.html --favicon 📊 \
  --scope "user-facing interaction flows of the app" \
  --watch "src/views/**,src/components/**" \
  --description "One-sentence subtitle"
```

- `--favicon`: required, one or two emoji. Keep it STABLE across updates.
- `--scope`: what the artifact is about, in one sentence. Required for any
  artifact derived from project files — it drives auto-updates later.
- `--watch`: comma-separated globs of the source files the artifact was
  derived from.
- Prints the shareable URL on stdout. Give it to the user.

The command records the artifact in `.artifacts/manifest.json` (commit this)
and its write token in `.artifacts/credentials.json` (auto-gitignored, never
commit or print tokens).

## Updating

```
node artifact.mjs update <id> [file] [--label "what-changed"]
```

Same URL, new version. The manifest supplies the write token and expected
version; on a version conflict the CLI explains and offers `--force`.
`node artifact.mjs list` shows known artifacts.

## Keeping artifacts fresh (do this without being asked)

After completing any task that modified project files in a project that has
`.artifacts/manifest.json`, run:

```
node artifact.mjs status
```

For each artifact reported stale, decide whether the changed files affect its
recorded scope. If they do, regenerate the page content to reflect the current
state of the project and run `update`. If they do not (e.g. a refactor with no
behavior change for a scope about user-facing flows), leave it and say so.

To surface staleness automatically at the end of every Claude Code turn, offer
the user: `node artifact.mjs install-hook` (adds a Stop hook to
`.claude/settings.json`).

## Password protection

```
node artifact.mjs create page.html --favicon 🔒 --title "Q3 Numbers" --password "..."
```

Content is encrypted locally (PBKDF2 600k + AES-256-GCM); the server stores
only ciphertext and viewers decrypt in the browser. Share the URL and the
password through different channels. Updates to a protected artifact need
`--password` again (ask the user; the password is never stored). Note: the
title and favicon are stored in plaintext as metadata — keep them
non-sensitive.

## Reading back

`GET <instance>/api/artifacts/<id>` returns metadata and version history;
`GET <instance>/api/artifacts/<id>/raw` returns the stored content
(`?v=N` for older versions). Viewer URLs also accept `?v=N`.
