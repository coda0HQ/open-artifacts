# Choosing and deploying an instance

The skill publishes to an **Open Artifacts instance** — a Cloudflare Worker
that stores content and serves pages. You need to point the skill at one.
Three ways to get an instance; pick based on your trust/storage needs.

## A — Use coda0.com, the official hosted instance (zero deployment setup)

[coda0.com](https://coda0.com) is the managed instance of Open Artifacts, run
by the project. Point the skill at it and start publishing:

```sh
export OPEN_ARTIFACTS_URL=https://coda0.com
```

- Nothing to deploy; works immediately.
- Artifact content is stored on that instance's Cloudflare account.
- To publish, authenticate with `node "$ARTIFACT_CLI" login --provider google` (see `auth.md`). Reads of public artifacts are open. Use `--password` for sensitive content —
  encryption is client-side, so the server only ever holds ciphertext.
- Best for: trying the skill out, non-sensitive content, quick shares.

## B — Self-host (full control)

Fork https://github.com/coda0HQ/open-artifacts, then from your clone:

```sh
pnpm install
npx wrangler d1 create open-artifacts          # put database_id into wrangler.production.jsonc
npx wrangler r2 bucket create open-artifacts-content
pnpm check:environments                         # validates isolated configs and dry-runs
```

Provision the distinct D1/R2/DO/Analytics/rate-limit resources named in the
Preview, Staging, and Production configs. Store `IDEMPOTENCY_SECRET` and
`REPAIR_TOKEN` as environment-scoped Worker secrets, never committed vars. Use
the repository's gated deploy workflow for application promotion; direct
`pnpm run deploy` is intentionally refused. Production requests never create
or alter schema: the workflow applies all numbered migrations before the
Worker is deployed.
Point the skill at your instance:

```sh
export OPEN_ARTIFACTS_URL=https://open-artifacts.<your-subdomain>.workers.dev
```

- Content stays on your own Cloudflare account.
- Production requires explicit `PUBLIC_CREATE_MODE`, `ANONYMOUS_COMMENTS`,
  `RATE_LIMIT_MODE`, and a 32+ byte `IDEMPOTENCY_SECRET`; invalid or missing
  configuration fails readiness. To use token-gated creation, set
  `PUBLIC_CREATE_MODE=token`, then set a create token and give it to trusted
  users:
  ```sh
  npx wrangler secret put CREATE_TOKEN --config wrangler.production.jsonc
  ```
  Then clients set `OPEN_ARTIFACTS_TOKEN=<same value>` (or put
  `createToken` in `.artifacts/config.json`).
- Free tier comfortably covers personal/small-team use.
- Best for: sensitive content without password protection, team shared
  instances, long-term ownership.

## C — Team shared instance

One operator deploys (mode B), configures production policy/secrets, and shares the
URL (and create token, if set) with the team. Everyone else just sets
`OPEN_ARTIFACTS_URL` (and `OPEN_ARTIFACTS_TOKEN` if gated). Updates are
still per-artifact: each artifact's write token lives in each user's
gitignored `.artifacts/credentials.json`.

## Optional deploy surfaces

The artifact format and CLI work without these features. A deployment may add
them independently:

- `OPEN_ARTIFACTS_WEB_FONTS=1` enables the `/fonts/*` proxy and allowlisted font
  CDNs. The artifact frame remains opaque; this flag does not add
  `allow-same-origin`.
- `LIVE_DO` enables the host's Live editor and the `/api/artifacts/:id/live*`
  routes. It requires a Durable Object binding for `LiveObject`; a normal
  self-hosted `wrangler.jsonc` without that binding keeps Live disabled.
- `OPEN_ARTIFACTS_HANDOFF=1` enables host-side webcam/microphone handoff
  recording and playback. It uses the existing R2 binding and does not require
  the Live Durable Object.

For local development with Live and owner permissions, use the repository's
`wrangler.dev.jsonc` (`wrangler dev -c wrangler.dev.jsonc`). Production must
use distinct D1/R2/DO identities, a declarative Durable Object migration,
explicit authorization/rate policies, a metrics binding, and kill switches;
never copy local-development resources or shortcuts.

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

## Raising the content cap (paid plans)

The content cap defaults to **4 MiB** — a deliberate free-tier envelope. On a
paid Cloudflare plan you can raise it by setting `MAX_CONTENT_MIB` (an integer
number of MiB) on the Worker:

Set it as a Worker var (not a secret — it is not sensitive):

```jsonc
// wrangler.jsonc
{ "vars": { "MAX_CONTENT_MIB": "12" } }
```

Or via the Cloudflare dashboard (Worker → Settings → Variables). Unset,
non-numeric (including partials like `12abc`), or `<= 0` keeps the 4 MiB
default. Set the **same** value in the client environment (`MAX_CONTENT_MIB=12`)
so the skill builder's output gate matches the service — otherwise a build the
CLI accepts could be rejected on publish. Raising it far past a few MiB is at
your own risk: the request body is buffered in Worker memory, so the real
ceiling is the Cloudflare Worker request-body / memory limit, not storage (R2
is effectively unbounded).

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
