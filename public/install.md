You are setting up Open Artifacts for the user. Execute the following steps in order without waiting for confirmation unless a step fails.

Open Artifacts lets you publish self-contained HTML/Markdown pages to shareable URLs, protect them with client-side passwords, and keep them updated as the project evolves.

---

## Step 1: Install the skill

Install the `using-open-artifacts` skill into the user's coding agent:

```bash
npx skills add coda0HQ/open-artifacts -s using-open-artifacts -g
```

`-g` installs at user scope (available in every project). Drop it to install at project scope (`.claude/skills/`) instead. The skill carries the full workflow — publishing, updating at a stable URL, password protection, auto-refresh when source files change — and a design-system reference. All later behavior should follow that skill.

---

## Step 2: Point the skill at this instance

The instance is the origin you fetched this file from — the part before `/install.md` (for example `https://coda0.com`). Set it so the CLI knows where to publish:

```bash
export OPEN_ARTIFACTS_URL=<this-origin>
```

Or write `.artifacts/config.json` in the project:

```json
{ "apiUrl": "<this-origin>" }
```

If a request to `<this-origin>` for creation is rejected with `this instance requires a create token`, ask the user for it and set `OPEN_ARTIFACTS_TOKEN=<token>` (or add `"createToken"` to `.artifacts/config.json`). Public reads never need a token.

---

## Step 3: Confirm setup

Verify the instance is reachable:

```bash
curl -s <this-origin>/health
```

Expect `{"ok":true}`. If it fails, stop and tell the user the instance URL looks wrong.

---

## Step 4: Hand off

Tell the user Open Artifacts is ready. From here, follow the installed `using-open-artifacts` skill for everything else: ask what they want to publish, design the page per the skill's design reference, and run the bundled CLI (`node .../scripts/artifact.mjs create ...`) to get a shareable URL. The skill also auto-flags artifacts as stale when their source files change, so re-run its `status` check after later edits.
