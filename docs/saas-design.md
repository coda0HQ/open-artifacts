# SaaS Layer — Design (Phase 1)

Status: proposal (not yet implemented). Scope locked: **single personal space**
per GitHub user — no workspaces/`services` concept in v1. This document is the
build reference; it is opinionated and concrete by design.

Verified against the real code (line numbers accurate as of writing) and against
official Cloudflare free-tier numbers fetched from the docs.

## Goal

Turn the anonymous, self-hostable open-artifacts Worker into a SaaS where a user
signs in with GitHub and manages the artifacts they own — **without breaking any
existing self-hoster**. Same codebase, two behaviors, selected purely by whether
three secrets are set. No monetization in v1.

## The core invariant: one binary, two behaviors

```
saasEnabled(env) = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.SESSION_SECRET)
```

- `saasEnabled === false` (today's self-hosters): `/auth/*`, `/login`,
  `/dashboard` return 404 from the Worker. `POST /api/artifacts` runs the
  existing `CREATE_TOKEN` gate (`src/api.ts:91-103`) **byte-for-byte** —
  anonymous when `CREATE_TOKEN` unset, token-gated when set. `owner_id` stays
  `NULL`. The `wt_`/`ch_` capability model is the only auth.
- `saasEnabled === true` (your hosted SaaS): OAuth routes activate, session
  cookies and `sk_` API keys resolve to an `owner_id`, the dashboard is
  reachable. **Login is required to create** — a `POST /api/artifacts` with
  neither a session nor an `sk_` returns `401 login required` (see below); the
  `CREATE_TOKEN` gate is bypassed for any request already carrying a valid
  session or `sk_`. Public *reads* (`GET /a/:id`, `/og/:id`, raw) are
  unaffected — anyone with a link can still view.

**"Anyone can use it" = anyone who signs in with GitHub.** When `saasEnabled` is
true, anonymous (no-session, no-`sk_`) creation is refused with `401`, so the
hosted instance cannot be spammed with owner-less artifacts. This is a rule of
the SaaS mode only; the forked open-source deploy (`saasEnabled === false`)
keeps today's anonymous/`CREATE_TOKEN` create path byte-for-byte.

**Code vs deployment:** the open-source GitHub repo stays MIT, one codebase.
Your SaaS is one Cloudflare Worker deployment of it (your D1/R2 + the three
secrets set); a self-hoster is another deployment of the same code with the
secrets unset. Workers Builds deploys *your* Worker on push; self-hosters
`git clone` and deploy to their own account.

## GitHub OAuth (in-Worker, no SDK)

The Worker is a **confidential client** (holds `client_secret` server-side), so
PKCE is deliberately **not** used — GitHub OAuth Apps ignore `code_challenge`.
CSRF on the redirect is covered by a **signed `state`** instead.

1. `GET /auth/github/login` → mint state, set cookie, 302 to
   `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=<PUBLIC_ORIGIN>/auth/github/callback&scope=read:user%20user:email&state=<S>&allow_signup=true`
2. `GET /auth/github/callback` → validate state, POST to
   `https://github.com/login/oauth/access_token` (`Accept: application/json`),
   then `GET https://api.github.com/user` (+ `/user/emails` if `email` null).
3. UPSERT into `users` keyed by `github_id` (immutable; `login` is renamable).

**Hardened state (fixes a confirmed login-CSRF hole):**
`state = base64url(16 random bytes) + "." + base64url(HMAC_SHA256(SESSION_SECRET, bytes))`.
Set before redirect as `oa_oauth=<state>; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`
and echoed in the authorize URL. On callback, in order: (a) reject if **either**
cookie or query state is missing/empty — this guards the
`timingSafeEqual("","") === true` trap in `src/tokens.ts:48`; (b) verify the
HMAC signature over `SESSION_SECRET`; (c) `timingSafeEqual(cookieState, urlState)`;
(d) clear the cookie.

**The GitHub access token is not stored.** We read identity once at callback and
discard it. We never act on the user's behalf against GitHub, so storing a
third-party secret at rest would be pure liability. Minimum scope
`read:user user:email`.

## Sessions: stateless signed cookie (no table, no KV)

`token = base64url(JSON{uid,iat,exp}) + "." + base64url(HMAC_SHA256(SESSION_SECRET, part1))`,
verified with the existing `timingSafeEqual` after a non-empty guard on both
parts. `uid = users.id`, `exp = iat + 7 days`.

Why stateless (justified against **verified** caps):

- **KV free = 1,000 writes/day** → a session write per login caps the instance
  at ~1,000 logins/day, and KV is eventually consistent. Rejected.
- **D1 free = 100,000 rows written/day** → a D1 session with sliding refresh
  writes on nearly every authed request, competing with the create budget.
  Rejected.
- **Stateless cookie = zero storage writes** to create, validate, or renew.
  Resolving `owner_id` needs only the `uid` in the signed payload, so the
  `users` table is never read on the write hot path.

Cookie: `oa_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`.

**Revocation tradeoff (accepted for v1):** stateless tokens can't be revoked
before `exp`. Logout clears the cookie; global break-glass is rotating
`SESSION_SECRET` (invalidates every session). Per-user forced revocation is
deferred to Phase 3 (embed `users.token_epoch` in the cookie). Long-lived
programmatic access uses revocable `sk_` keys, not sessions.

## D1 schema changes

Append to `SCHEMA[]` in `src/store.ts` (runs via `db.batch`, order preserved):

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,   -- UNIQUE already creates the index; no separate one
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (  -- Phase 2 table; idempotent, safe to create in Phase 1
  key_hash TEXT PRIMARY KEY,           -- sha256Hex(sk_...), raw key never stored
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
```

Add to `MIGRATIONS[]` (each wrapped in `.catch(()=>{})`, run concurrently via
`Promise.all` — must be independent, so **only** the `ADD COLUMN` goes here):

```sql
ALTER TABLE artifacts ADD COLUMN owner_id TEXT;   -- nullable; legacy/anon rows stay NULL
```

The owner index depends on the column above, and `Promise.all` does **not**
order it after the `ALTER`. So it is a **separate awaited post-migration step**
in `ensureSchema.run()` (after `await Promise.all(MIGRATIONS…)`), run as
`await db.exec(sql).catch(()=>{})`:

```sql
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id);
```

`versions` does **not** need `owner_id` — listing is by artifact, and ownership
is resolved via the parent `artifacts` row.

## Auth resolution

`resolveCaller(c): Promise<{ ownerId: string | null }>` runs before create/write.
First line `await ensureSchema(c.env.DB)` (reuse the store's memoized init) so
`api_keys` exists before it is queried. Precedence — explicit credential beats
ambient cookie:

1. **Bearer `sk_`** (Phase 2): `SELECT user_id FROM api_keys WHERE key_hash = sha256Hex(token)`.
   Hit → `ownerId = user_id`; `last_used_at` updated fire-and-forget via
   `c.executionCtx.waitUntil`, **throttled** to at most once per key per 15 min
   (keeps `sk_` polling off the D1 100k-writes/day meter). Miss → 401.
2. **`oa_session` cookie** (both parts non-empty, HMAC verifies, `exp > now`):
   `ownerId = payload.uid`. No DB read.
3. **Legacy**: `ownerId = null`. Then the create path diverges by mode:
   - `saasEnabled === false` (self-hoster): the `CREATE_TOKEN` gate runs
     byte-for-byte — anonymous when unset, token-gated when set.
   - `saasEnabled === true` (your SaaS): `POST /api/artifacts` returns
     `401 login required`. Anonymous creation is refused so the hosted instance
     stays owner-scoped and un-spammable. (Reads and the `wt_`/`ch_` **update**
     of an already-existing artifact are not affected — this gate is on
     *create* only.)

`authorizeWrite` (`src/api.ts:38-72`) gains a **second** grant path; either works:

- **Capability (unchanged):** presented token matches `record.tokenHash` (`wt_`)
  or `record.channelHash` (`ch_`). The only path for `NULL`-owner/anon artifacts.
- **Ownership (new):** `record.owner_id !== null && resolveCaller().ownerId === record.owner_id`.
  Requiring `owner_id !== null` means a logged-in user can **never** claim an
  anonymous artifact by ownership. Cross-tenant (A edits B's) fails both → 403.

The `wt_` write token is **still minted and returned** even for owned artifacts —
ownership is additive, so existing `wt_` sharing and the CLI keep working.

## Dashboard trust zone

The dashboard is first-party app UI and **must not** reuse the `/a/:id` sandbox
CSP (`src/wrap.ts:28-46`: `sandbox …; connect-src 'none'`) — that forbids
`fetch()`. It is a separate origin-of-trust from untrusted artifact content.

- Served as `public/dashboard.html` + `public/dashboard.js` (**JS externalized**
  so the CSP needs no `unsafe-inline` on the cookie-bearing origin). The HTML
  shell is gated through the Worker (via `run_worker_first`) so `saasEnabled`
  can 404 it; `/dashboard.js` stays a plain static asset (unmetered).
- Dashboard CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
- All `/api/me` fields (`login`/`name` are attacker-controllable via the GitHub
  display name) render via `textContent`, never `innerHTML`.

**CSRF for cookie-authed mutations** (defense in depth), enforced server-side
**only when the cookie is the auth source**: (1) `SameSite=Lax` withholds the
cookie on cross-site POST; (2) `Origin === PUBLIC_ORIGIN` **and** a custom header
`X-OA-CSRF: 1` the SPA always sends (a custom header can't ride a cross-origin
request without a CORS preflight, and the Worker sends no
`Access-Control-Allow-Credentials`). **All Bearer credentials
(`sk_`/`wt_`/`ch_`/`CREATE_TOKEN`) are exempt** — a bearer credential is not
ambient — so existing CLI writes never 403. This needs a regression test:
`Bearer wt_` PUT with no `Origin` header must succeed.

## Routes

New: `GET /auth/github/login`, `GET /auth/github/callback`, `POST /auth/logout`,
`GET /api/me`, `GET /api/artifacts` (owner list), `GET /login`, `GET /dashboard`.
Phase 2 adds `POST/GET/DELETE /api/keys`.

Modified: `POST /api/artifacts` + `PUT/DELETE/GET /api/artifacts/:id` become
owner-aware via `resolveCaller`/`authorizeWrite`; anon/`CREATE_TOKEN` behavior is
byte-for-byte unchanged when `saasEnabled` is false.

`wrangler.jsonc`: `assets.run_worker_first` becomes
`["/api/*","/a/*","/og/*","/auth/*","/login","/dashboard"]`. The `ASSETS`
binding is already present.

## CLI migration (Phase 2)

One `Authorization` slot carries every credential kind; the server disambiguates
by prefix. No wire-protocol change.

- New `OPEN_ARTIFACTS_API_KEY` → sent as `Authorization: Bearer sk_…`.
- CLI precedence: `--token` > `OPEN_ARTIFACTS_API_KEY` (`sk_`) >
  `OPEN_ARTIFACTS_TOKEN` (existing `wt_`/`ch_`/`CREATE_TOKEN`) >
  `credentials.json` `apiKey`. Existing `OPEN_ARTIFACTS_TOKEN`-only users
  unaffected.
- `ch_` channel is orthogonal — it travels in the JSON body `channel` field
  (`src/api.ts:127`), not the header — so a user can authenticate a create with
  `sk_` **and** pass a `ch_` to bind the URL.
- `artifact login` (loopback OAuth): CLI opens
  `<host>/auth/github/login?cli=1&redirect_uri=http://localhost:PORT/callback`.
  **Hardened `redirect_uri` validation (fixes a confirmed `sk_`-exfiltration
  hole):** parse with `new URL()`; require `protocol === 'http:'` and `hostname`
  **exactly** one of `{localhost,127.0.0.1,::1}` (never substring/prefix/suffix,
  so `127.0.0.1.evil.com` is rejected); reject any userinfo (`@`). Validated at
  **both** `/login` and `/callback`. `cli=1` alone is not the defense — strict
  hostname equality is.

## Free-tier viability

Auth additions touch neither KV nor the D1 write hot path.

- **Worker requests (100k/day)** is the **tightest bottleneck**, driven by public
  artifact *view* traffic, not user count. `/login` + `/dashboard` route through
  the Worker (1 invocation/load) so gating works; `/dashboard.js` stays
  unmetered. Auth adds ~2 invocations/login.
- **D1 writes (100k/day):** create ~2 rows, update ~2, login UPSERT = 1, `sk_`
  `last_used` throttled to ≤1/key/15min. **Sessions write zero.** ≈ 50k
  creates/day headroom.
- **KV:** used for nothing.
- **R2 (1M Class-A/mo):** one object `put` per create/update (metadata is in D1),
  so 1 Class-A op each. 10M Class-B reads/mo and 10GB storage are generous.

Forced to the $5 D1/Workers Paid plan when sustained traffic exceeds ~100k
req/day (~>1 req/s) or content nears R2 10GB — a traffic problem, not a
user-count problem.

## Roadmap (each phase independently shippable, self-hoster-safe)

1. **Phase 1 — a logged-in GitHub user owns an artifact and sees it in a minimal
   dashboard.** `saasEnabled` gate; hardened OAuth; stateless cookie sessions;
   `users` table + `owner_id` ALTER + awaited owner index; `resolveCaller`
   (session + legacy branches); `POST /api/artifacts` writes `owner_id`;
   `GET /api/artifacts` owner list; `GET /api/me`; `authorizeWrite` ownership
   path; minimal gated dashboard; CSRF only in the cookie branch.
2. **Phase 2 — programmatic access + CLI.** Revocable hashed `sk_` keys
   (`POST/GET/DELETE /api/keys`); `resolveCaller` `sk_` branch; CLI
   `OPEN_ARTIFACTS_API_KEY` + `artifact login`/`logout`/`whoami` with strict
   loopback validation.
3. **Phase 3 — management, safety, lifecycle.** Dashboard management UI
   (rename/delete, version history, rotate `wt_`, claim-legacy-anon flow behind
   proof of `wt_`); per-user quotas via aggregate D1 counters; per-user forced
   revocation (`token_epoch` in the cookie); a Cron Trigger (1 of 5 free) to
   prune expired artifacts + orphaned R2 objects. Multiple workspaces stay out
   of scope.

## Top risks

1. `SESSION_SECRET` rotation is the only global logout and invalidates every
   session + signed state at once — an operational break-glass, not routine.
2. A leaked `oa_session` cookie is valid until its 7-day `exp`. Mitigated by
   `HttpOnly`+`Secure`+`SameSite=Lax`; long-lived access steered to revocable
   `sk_`.
3. The CSRF guard must key on "cookie is the auth source" and exempt all Bearer;
   a blanket POST/PUT/DELETE guard would 403 every existing CLI write. Locked by
   a regression test.
4. Loopback `redirect_uri` must use exact parsed-hostname equality; any lenient
   rewrite re-opens `sk_` account takeover.
5. The owner index must stay a separate awaited step, not fold back into the
   concurrent `MIGRATIONS[]`, or early dashboard listings silently full-scan.
6. GitHub `login`/`name` are attacker-controllable; `textContent`-only rendering
   must be enforced in review — one `innerHTML` slip on the cookie origin is
   DOM-XSS.
