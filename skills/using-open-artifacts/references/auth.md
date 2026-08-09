# Authenticating to a hosted instance

An Open Artifacts instance is either **open** (anyone can create; optionally
gated by a `CREATE_TOKEN` - see `deployment.md`) or **hosted/SaaS** (requires
login, e.g. coda0.com). On a hosted instance your agent publishes *as you* by
authenticating once with `node "$ARTIFACT_CLI" login`, which stores a long-lived
`sk_` API key locally. The instance keeps only the key's hash, never the raw
key.

The CLI is `scripts/artifact.mjs` next to the skill's `SKILL.md`. Resolve that
directory as `SKILL_DIR`, set `ARTIFACT_CLI="$SKILL_DIR/scripts/artifact.mjs"`,
and run `node "$ARTIFACT_CLI" <command>` from the project root. Do not `cd`
into the skill directory for Recipe operations: the CLI resolves Recipes,
fragments, manifests, and watch globs against the current project root.

## Give this to your coding agent

Copy this block to your agent so it authenticates to coda0.com and obtains
an API key:

```
Authenticate to coda0.com so you can publish artifacts:
1. Ensure OPEN_ARTIFACTS_URL=https://coda0.com (write {"apiUrl":"https://coda0.com"} to .artifacts/config.json if not set).
2. Run: node "$ARTIFACT_CLI" login --provider google
3. A browser opens to coda0.com - the user completes the Google sign-in there.
4. The API key (sk_) is stored automatically in .artifacts/credentials.json. You can then publish with `node "$ARTIFACT_CLI" create`.
```

## What `node "$ARTIFACT_CLI" login` does

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

`create`, `show`, `whoami`, and `live` use the stored `sk_` when a hosted
instance needs an account session. `update` and `delete` use the per-artifact
write token saved in `.artifacts/credentials.json`; logging in does not replace
that token. On a hosted instance, new artifacts default to **private**; set
`artifact.visibility` to `org` or `public` in the Recipe to share within your
org or with anyone who has the link. `node "$ARTIFACT_CLI" whoami` confirms
who you are logged in as; `node "$ARTIFACT_CLI" logout` clears the local key.

## Token precedence (gotcha)

The CLI picks the auth token in this order: `--token` flag >
`OPEN_ARTIFACTS_API_KEY` > the logged-in `sk_` (`credentials.json` `apiKey`)
> `OPEN_ARTIFACTS_TOKEN` > `config.json` `createToken`. The logged-in `sk_`
wins over `OPEN_ARTIFACTS_TOKEN` / `createToken` (which are CREATE_TOKEN-gate
secrets for self-hosted instances and would publish as anonymous on a hosted
instance). But `--token` or `OPEN_ARTIFACTS_API_KEY` still overrides `sk_` -
don't leave them set on a hosted instance unless you mean to.

Artifact write credentials have explicit lifecycle commands:

```sh
node "$ARTIFACT_CLI" credentials status <artifact-id>
node "$ARTIFACT_CLI" credentials rotate <artifact-id> --grace 30
node "$ARTIFACT_CLI" credentials revoke <artifact-id> <credential-id>
node "$ARTIFACT_CLI" credentials recover <artifact-id> # manager login required
```

Rotation stores the newly returned token without printing it. Grace is optional
and capped at 300 seconds; use zero for suspected compromise. Status output
contains IDs and timestamps, never raw tokens. Recovery revokes every prior
credential and requires the hosted Authorizer's manage permission.

Manifest and Recipe files never contain secrets. The default compatibility
backend is the gitignored, checksummed `credentials.json` written as `0600`.
`secret-store.mjs` also provides macOS Keychain and read-only organization
environment adapters so a host can replace the file backend without changing
command behavior.
