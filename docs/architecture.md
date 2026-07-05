# Open Artifacts — Architecture

Open-source clone of Claude Code Artifacts, self-hosted entirely on Cloudflare.
An agent skill (installed via `npx skills add`) lets any coding agent publish
self-contained HTML/Markdown pages to a URL, share them (optionally
password-encrypted, zero-knowledge), and keep them updated as the project they
describe evolves.

## Components

```
                 npx skills add FradSer/open-artifacts
                                │
┌─ user's project ──────────────▼─────────────┐
│  .claude/skills/using-open-artifacts/       │
│    SKILL.md            (agent instructions) │
│    scripts/artifact.mjs (publish CLI)       │
│  .artifacts/manifest.json  (committed)      │
│  .artifacts/credentials.json (gitignored)   │
└──────────────┬───────────────────────────────┘
               │ HTTPS JSON (bearer tokens)
┌─ Cloudflare ─▼───────────────────────────────┐
│  Worker (Hono)                               │
│    POST /api/artifacts        create         │
│    PUT  /api/artifacts/:id    update         │
│    GET  /api/artifacts/:id    metadata       │
│    GET  /api/artifacts/:id/raw raw content   │
│    DELETE /api/artifacts/:id  delete         │
│    GET  /a/:id                viewer page    │
│    GET  /                     landing (asset)│
│  D1: metadata, token hashes, version index   │
│  R2: content bodies content/<id>/<version>   │
│  ratelimits binding: create/update abuse cap │
└──────────────────────────────────────────────┘
```

## Storage (D1 + R2)

KV was rejected: eventual consistency up to 60 s cross-colo, 1 write/s/key,
1,000 writes/day free — wrong for frequently-updated artifacts. D1 is strongly
consistent (metadata, pointers), R2 is strongly consistent read-after-write via
bindings (bodies). D1's 2 MB row cap forbids storing HTML in D1.

- `artifacts(id, token_hash, title, description, favicon, format, encrypted,
  current_version, created_at, updated_at)`
- `versions(artifact_id, version, label, size, created_at)`
- R2 object `content/<id>/<v>`: plaintext body, or for encrypted artifacts a
  JSON envelope `{v, alg: "AES-GCM", kdf: "PBKDF2-SHA256", iterations, salt,
  iv, ciphertext}` (all base64).

Schema is applied lazily at first request (`CREATE TABLE IF NOT EXISTS`,
memoized per isolate) — zero-step deploys for self-hosters and zero-setup
vitest miniflare tests.

## Identity and auth (no accounts)

- Artifact id: 12 chars, crypto-random, base58-like alphabet (unguessable,
  unlisted-by-default sharing model).
- Write token: `wt_` + 32 random bytes base64url, returned once at create.
  Only SHA-256(token) is stored; compared with `crypto.subtle.timingSafeEqual`.
- Optional instance gate: if the `CREATE_TOKEN` secret is set on the deploy,
  POST /api/artifacts requires it as a bearer token. Unset = open instance
  (rate-limited only).
- Optional canonical domain: if `PUBLIC_URL` (e.g. `https://coda0.com`) is set
  on the deploy, it is the base of every generated link (the API `url`,
  `og:url`, `og:image`) regardless of the host the request arrived on — so the
  hosted SaaS instance keeps links on its domain even when reached via
  `*.workers.dev`. Unset, links derive from the request origin, so a
  self-hosted instance's links stay on its own domain unchanged.

## Mirroring the real Artifact tool contract

- Authors write body-only HTML (a `<title>` tag anywhere is honored); the
  Worker wraps it at serve time in a doctype/head/body skeleton with a minimal
  CSS reset, emoji favicon (SVG data URI), viewport meta, and theme support.
- Theme contract: `@media (prefers-color-scheme: dark)` is the default signal;
  a floating toggle stamps `data-theme="light|dark"` on `<html>` which must
  win in both directions.
- `PUT` accepts `baseVersion`; mismatch → 409 unless `force: true`.
- Versions have optional `label` (≤ 60 chars); `GET /a/:id?v=N` serves history.
- Favicon: 1–2 emoji, validated server-side.
- Same id = same URL forever; redeploys bump the version.

## Serving untrusted HTML safely

Every user-content response (viewer page and /raw) carries:

```
Content-Security-Policy: sandbox allow-scripts allow-modals allow-forms
  allow-popups; default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
  media-src data: blob:; connect-src 'none'; form-action 'none';
  base-uri 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The CSP `sandbox` directive gives the document an opaque origin (the
response-header equivalent of iframe sandbox): artifact scripts cannot read
cookies/localStorage of the serving origin nor call the API with ambient
credentials, and `connect-src 'none'`/`default-src 'none'` blocks all external
exfiltration. workers.dev is on the Public Suffix List, isolating instances
from each other. The wrapper's theme toggle wraps localStorage in try/catch
(opaque origin throws) — theme choice is per-load, which is acceptable.

## Link previews (OpenGraph)

Every viewer response (plain and unlock shell) carries OpenGraph + Twitter
tags. `og:image` points at `GET /og/:id`, which returns a 1200x630 **PNG** —
not SVG, because Facebook, X, LinkedIn, Slack, iMessage and Discord all refuse
to render an SVG `og:image`, so an SVG card shows no preview image at all.

The card is a self-contained SVG (dark card, accent bar, wrapped title +
description, brand wordmark) rasterized with `@resvg/resvg-wasm`. resvg has no
system fonts, so two Inter subsets (one weight each, Latin + punctuation,
~90 KB each) are instanced/subset by `scripts/vendor-fonts.mjs` and embedded as
base64 in `src/generated/fonts.ts`; the `.wasm` is a static import (the runtime
forbids compiling Wasm from bytes). Total bundle stays near 1 MB gzipped, well
under the 3 MB free-plan limit. The emoji favicon is deliberately omitted from
the card: resvg cannot render color emoji, and rendering it would need an
external Twemoji fetch, which the "no external requests" model rejects — it
still appears as the page favicon. Because the fonts are Latin-only, a title
outside that range (e.g. CJK) would draw blank, so a title (or description)
with uncovered codepoints falls back to a text-light branded card; the real
title/description still reach viewers via the `og:*` meta tags. User-controlled
title/description are HTML-escaped into the SVG text nodes, and the response is
cached (`max-age=300`) so crawlers do not re-rasterize on every hit.

## Password protection (zero-knowledge)

The server never sees the password or plaintext:

- The skill CLI encrypts locally: PBKDF2-HMAC-SHA256, 600,000 iterations,
  16-byte salt → AES-256-GCM, fresh 12-byte IV per version.
- Viewer: the Worker serves a trusted unlock shell (strict CSP, ciphertext
  envelope inlined — `connect-src 'none'` still holds). The browser derives
  the key, decrypts, wraps the plaintext with the same skeleton template, and
  injects it into `<iframe sandbox="allow-scripts allow-modals" srcdoc>`.
- Wrong password = AES-GCM auth failure → error message, no content.
- Workers could not do this server-side anyway: workerd caps PBKDF2 at
  100,000 iterations and free CPU at 10 ms.

Markdown is rendered client-side (vendored `marked` inlined into the page)
so the encrypted path and the plain path share one code path, and the Worker
stays under the CPU cap.

## The skill and auto-updating artifacts

Repo layout `skills/using-open-artifacts/{SKILL.md,scripts/artifact.mjs,references/design.md}`
works with `npx skills add FradSer/open-artifacts` (vercel-labs/skills installs
to `.claude/skills/` by default, `-g` for `~/.claude/skills/`; follows the
Agent Skills standard so ~70 agents are supported).

`artifact.mjs` (Node ≥ 20, zero deps):

- `create <file> --title --favicon [--password] [--scope "..."] [--watch glob,glob]`
- `update <id> <file> [--label] [--password]`
- `status [--hook]` — compares current hashes of files matching each
  manifest entry's watch globs against the snapshot taken at last publish;
  reports stale artifacts (exit 1, or Stop-hook JSON with
  `hookSpecificOutput.additionalContext` phrased as factual statements).
- `list`, `delete <id>`
- Config resolution: `OPEN_ARTIFACTS_URL` env → `.artifacts/config.json` →
  `~/.config/open-artifacts/config.json`.

State in the user's project:

- `.artifacts/manifest.json` (committed): id, url, title, favicon, format,
  scope description, watch globs, snapshot hash per artifact.
- `.artifacts/credentials.json` (auto-gitignored): write tokens.

Auto-update loop: SKILL.md instructs the agent to run `status` after
completing work and regenerate any stale artifact within its recorded scope;
a Stop hook (`node ${CLAUDE_SKILL_DIR}/scripts/artifact.mjs status --hook`)
surfaces staleness even when the agent forgets. Updates from CI/plain git are
out of scope for v1 (documented).

## Stack

- Wrangler 4 (`wrangler.jsonc`, compatibility_date 2026-07-03), workers.dev
- Hono 4.12 (typed bindings, bearer-auth middleware)
- Vitest 4.1 + @cloudflare/vitest-pool-workers 0.18 (`cloudflareTest()` Vite
  plugin; integration via `exports.default.fetch()` from `cloudflare:workers`)
- Biome, pnpm, TypeScript strict; `wrangler types` generates `Env`
- Static assets (`public/`) for the landing page. `run_worker_first` includes
  `/` so the Worker fetches the asset via the `ASSETS` binding and, only on the
  hosted host (`coda0.com`), rewrites its brand tokens to "coda0" with
  `HTMLRewriter` (`src/home.ts`) — server-side, so crawlers and no-JS visitors
  see the SaaS identity. Every other deploy returns the asset untouched.

## Limits

- Content cap 4 MiB (post-base64 for encrypted) — fits free-tier envelope.
- Rate limits (best-effort, per-colo): create 20/min/IP, update 60/min/id.
- Free tier headroom: Workers 100k req/day, R2 1M writes/mo, D1 100k row
  writes/day.
