# Choosing and deploying an instance

The skill publishes to an **Open Artifacts instance** — a Cloudflare Worker
that stores content and serves pages. You need to point the skill at one.
Three ways to get an instance; pick based on your trust/storage needs.

## A — Use coda0.com, the official hosted instance (zero setup)

[coda0.com](https://coda0.com) is the managed instance of Open Artifacts, run
by the project. Point the skill at it and start publishing:

```sh
export OPEN_ARTIFACTS_URL=https://coda0.com
```

- Nothing to deploy; works immediately.
- Artifact content is stored on that instance's Cloudflare account.
- Creation is open (rate-limited). Use `--password` for sensitive content —
  encryption is client-side, so the server only ever holds ciphertext.
- Best for: trying the skill out, non-sensitive content, quick shares.

## B — Self-host (full control)

Fork https://github.com/coda0HQ/open-artifacts, then from your clone:

```sh
pnpm install
npx wrangler d1 create open-artifacts          # put database_id into wrangler.jsonc
npx wrangler r2 bucket create open-artifacts-content
npx wrangler deploy
```

The schema initializes itself on first request — no migration step. Point
the skill at your instance:

```sh
export OPEN_ARTIFACTS_URL=https://open-artifacts.<your-subdomain>.workers.dev
```

- Content stays on your own Cloudflare account.
- To restrict who can create artifacts, set a create token and give it to
  trusted users:
  ```sh
  npx wrangler secret put CREATE_TOKEN
  ```
  Then clients set `OPEN_ARTIFACTS_TOKEN=<same value>` (or put
  `createToken` in `.artifacts/config.json`).
- Free tier comfortably covers personal/small-team use.
- Best for: sensitive content without password protection, team shared
  instances, long-term ownership.

## C — Team shared instance

One person deploys (mode B), optionally sets `CREATE_TOKEN`, and shares the
URL (and create token, if set) with the team. Everyone else just sets
`OPEN_ARTIFACTS_URL` (and `OPEN_ARTIFACTS_TOKEN` if gated). Updates are
still per-artifact: each artifact's write token lives in each user's
gitignored `.artifacts/credentials.json`.

## Custom domain (canonical links)

By default every generated link (the API `url`, `og:url`, `og:image`) follows
the host the request arrived on, so a self-hosted instance's links stay on its
own domain with no configuration.

If you front the Worker with a custom domain (e.g. the hosted instance on
`coda0.com`) and want links pinned to it — even when the Worker is also
reachable at `*.workers.dev` — set the `PUBLIC_URL` secret to that base URL:

```sh
npx wrangler secret put PUBLIC_URL      # e.g. https://coda0.com
```

Then route the domain to the Worker (Cloudflare dashboard → the Worker →
Settings → Domains & Routes → add a custom domain). Leave `PUBLIC_URL` unset
to keep the request-origin behavior.

## Trust model summary

| Content sensitivity | Recommended mode |
| --- | --- |
| Public / try-it-out | A (public instance) |
| Sensitive, but `--password` encrypted | A or B — server only holds ciphertext |
| Sensitive, no password | B (self-host) |
| Team / org | C |

Password protection is **zero-knowledge**: the CLI encrypts locally
(PBKDF2-HMAC-SHA256 600k + AES-256-GCM), the server stores only
`{salt, iv, iterations, ciphertext}`, and the viewer decrypts in the
browser. The password never leaves the author's machine — so even on the
public instance, encrypted artifacts stay confidential regardless of who
operates the Worker.

## Config file

Instead of env vars, you can write `.artifacts/config.json` (project) or
`~/.config/open-artifacts/config.json` (global):

```json
{
  "apiUrl": "https://open-artifacts.<subdomain>.workers.dev",
  "createToken": "optional-create-token"
}
```
