# Authenticating to a hosted instance

An Open Artifacts instance is either **open** (anyone can create; optionally
gated by a `CREATE_TOKEN` - see `deployment.md`) or **hosted/SaaS** (requires
login, e.g. coda0.com). On a hosted instance your agent publishes *as you* by
authenticating once with `node artifact.mjs login`, which stores a long-lived
`sk_` API key locally. The instance keeps only the key's hash, never the raw
key.

The CLI is `${CLAUDE_SKILL_DIR}/scripts/artifact.mjs`, run with `node` - the
examples below assume the working directory is the skill's `scripts/` dir (or
you prefix the path). Every `create`/`update`/`delete` is also
`node artifact.mjs <command>`.

## Give this to your coding agent

Copy this block to your agent so it authenticates to coda0.com and obtains
an API key:

```
Authenticate to coda0.com so you can publish artifacts:
1. Ensure OPEN_ARTIFACTS_URL=https://coda0.com (write {"apiUrl":"https://coda0.com"} to .artifacts/config.json if not set).
2. Run: node artifact.mjs login --provider google
3. A browser opens to coda0.com - the user completes the Google sign-in there.
4. The API key (sk_) is stored automatically in .artifacts/credentials.json. You can then publish with `node artifact.mjs create`.
```

## What `node artifact.mjs login` does

1. The CLI starts a local callback server on `127.0.0.1` and opens a browser
   to `<instance>/auth/google/login?cli=1&redirect_uri=http://127.0.0.1:<port>/callback`.
2. You sign in with Google on the instance. The instance mints a one-time
   code and redirects back to the local server.
3. The CLI exchanges that code at `POST /api/keys/exchange` for an `sk_` key,
   stored in `.artifacts/credentials.json` (gitignored).

`--provider google` goes straight to Google; omit it to land on the
instance's `/login` page and pick a provider. `--port` overrides the callback
port. The loopback `redirect_uri` is validated strictly
(`localhost`/`127.0.0.1`/`::1` only), so the key can't be exfiltrated to an
attacker's server.

## After login

`create`/`update`/`delete` send the stored `sk_` automatically - no env var
needed. On a hosted instance, new artifacts default to **private**; set
`artifact.visibility` to `org` or `public` in the Recipe to share within your
org or with anyone who has the link. `node artifact.mjs whoami` confirms who
you are logged in as; `node artifact.mjs logout` clears the key.

## Token precedence (gotcha)

The CLI picks the auth token in this order: `--token` flag >
`OPEN_ARTIFACTS_API_KEY` > `OPEN_ARTIFACTS_TOKEN` > `config.json`
`createToken` > the logged-in `sk_` (`credentials.json` `apiKey`). If
`OPEN_ARTIFACTS_TOKEN` is set (e.g. left over from a self-hosted instance),
it **overrides** the login key - the agent would then publish as anonymous
and could not read its own private artifacts. Unset `OPEN_ARTIFACTS_TOKEN` on
a hosted instance, or pass `--token sk_...` explicitly.

A `sk_` is a long-lived credential. If one leaks, rotate by logging in again
from a clean machine and treating the old key as compromised (per-key
revocation is not yet exposed in the CLI).
