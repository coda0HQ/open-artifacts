# Artifact Recipes

Every Open Artifact is generated from a versioned JSON Recipe and ordered local
fragments. `create` and `update` never publish an authored HTML or Markdown file
directly. They validate and compose the Recipe in memory, then make one publish
request with the final bytes.

## Recipe v1

Use `recipe.schema.json` for editor validation. Unknown keys are errors. The
schema ships inside the skill at `references/recipe.schema.json`; the
`$schema` value below is an example placeholder — point it at the schema copy
you edit against (a path relative to the Recipe, or a published URL). `validate`
does not fetch or enforce `$schema`; it is editor-only.

`artifact.favicon` must be one or two **emoji** characters — specifically
characters in the Unicode `Extended_Pictographic` or `Regional_Indicator`
properties (a flag like `🇯🇵` counts as one, since both Regional Indicators
form one grapheme cluster). Plain text, letters, and geometric/dingbat
symbols like `CB`, `◢`, `⌥`, or `◷` are rejected even though they are single
graphemes. If unsure, use any colorful emoji from your system picker. Keep
the favicon stable across versions.

```json
{
  "$schema": "./recipe.schema.json",
  "version": 1,
  "artifact": {
    "title": "Release readiness",
    "description": "Current launch status",
    "favicon": "🚦",
    "format": "html",
    "level": 2,
    "canvas": false,
    "channel": "release-readiness",
    "scope": "Release status and launch blockers",
    "watch": ["src/**", "docs/release/**"],
    "local": false,
    "autoUpdate": false
  },
  "document": {
    "language": "en",
    "theme": "editorial-control-room",
    "fragments": {
      "theme": ["fragments/theme.css"],
      "styles": ["fragments/components.css"],
      "body": ["fragments/summary.html", "fragments/details.html"],
      "scripts": ["fragments/behavior.js"]
    }
  },
  "security": {
    "encrypted": false,
    "passwordCredential": null
  },
  "build": {
    "strategy": "auto"
  }
}
```

Fragment paths are relative to the **Recipe file's own directory**, not the
current working directory — the resolver runs `resolve(recipeDir, path)`, so
`fragments/theme.css` means "next to the Recipe", regardless of where you run
the CLI from. Paths must be project-relative (no absolute paths, no `//` or
scheme-prefixed URLs), ordered, unique, and must resolve inside the project
root. Symlinks cannot escape the root. HTML Recipes require at least one theme
fragment. Markdown Recipes accept body fragments only. React Recipes accept
exactly one body fragment — the JSX/TSX entry (see "React/JSX format" below).

`document.theme` is an optional label for the design direction (shown in the
recipe comment, no runtime effect). HTML theme comes from theme fragments and
Markdown from the viewer's default `.oa-md` shell, so a Markdown Recipe may omit
`document.theme` entirely (or set it to `null`) — it carries no styling.

## Composition

The builder runs two local passes:

1. **Structure:** parse the Recipe, resolve fragment paths, enforce limits, and
   choose `direct` or `staged` from fragment count, byte size, section count,
   and Canvas frame count.
2. **Detail:** read fragments in declared order, inject `tokens.css`, and
   compose final bytes. Canvas Recipes also receive the vendored CSS, runtime,
   zoom controls, and optional tour controls from `canvas.md`.

Both strategies produce one final payload and one publish request. Builds have
no timestamps or random values. The Manifest records SHA-256 hashes for the
normalized Recipe, ordered inputs, and final output.

## React/JSX format

`"format": "react"` publishes a React component. Set `artifact.format` to
`"react"` and give `document.fragments.body` **exactly one** JSX/TSX entry that
**default-exports** a component; no theme, styles, or scripts fragments (put the
whole component — markup, styles via inline `style`/CSS variables, and behavior —
in that one file, importing helpers from it). `artifact.title` is required (a
compiled bundle has no extractable title).

```json
{
  "artifact": { "title": "React counter", "favicon": "⚛️", "format": "react", "...": "..." },
  "document": { "language": "en", "theme": null,
    "fragments": { "theme": [], "styles": [], "body": ["fragments/App.jsx"], "scripts": [] } }
}
```

At build time the skill **precompiles the JSX with esbuild** and bundles React +
ReactDOM + the component into **one self-contained IIFE** (production React,
minified, deterministic). The viewer inlines that bundle as a nonce'd
`<script>` next to a `<div id="oa-root">` mount node, so it renders under the
**same strict CSP as every other format** — nonce-only `script-src`, no
`'unsafe-eval'`, no external script host. Nothing is fetched at runtime; the
stored artifact is fully self-contained.

The component reads the viewer's design tokens (`--oa-fg`, `--oa-accent`, …, set
in both light and dark) via inline styles or `var(...)`, so it themes itself
with no separate stylesheet. See `examples/recipes/react/`.

**In-browser transforms are rejected.** A recipe that ships a runtime JSX
transform (Babel standalone, `<script type="text/babel">`) fails the build with
a *precompile JSX* error: that path needs `'unsafe-eval'` and an external script
host, both blocked by the viewer CSP. Author plain JSX; the skill compiles it.
React format requires the build-time tooling (`esbuild`, `react`, `react-dom`)
to be resolvable where the skill runs.

## Security and validation

The builder rejects path traversal, duplicate or oversized fragments, external
scripts and styles, remote media, dynamic imports, network APIs, malformed
inline JavaScript, full-document markup in body fragments, and output above the
service limit. Canvas builds also validate frame IDs, geometry, connectors,
tours, and builder-owned controls.

Shared Recipes and fragments may be committed. A local or encrypted Recipe must
live under `.artifacts/recipes.local/`, and all of its fragments must live under
`.artifacts/fragments.local/`. These directories, credentials, and
`.artifacts/previews/` are gitignored.

Because fragment paths resolve against the **Recipe file's own directory**, a
local Recipe at `.artifacts/recipes.local/report.recipe.json` reaches its
fragments via `../fragments.local/...`. The local layout is:

```
.artifacts/
  recipes.local/
    report.recipe.json          # fragment paths here use ../fragments.local/
  fragments.local/
    report/
      theme.css
      body.html
      behavior.js
```

with the Recipe referencing them as:

```json
"fragments": {
  "theme": ["../fragments.local/report/theme.css"],
  "body": ["../fragments.local/report/body.html"],
  "scripts": ["../fragments.local/report/behavior.js"]
}
```

If a local Recipe is misplaced, validation reports both rules at once — the
Recipe path and every fragment that must also move under `fragments.local/`.

**Run `validate`/`create` from the project root with a project-relative Recipe
path** (e.g. `node artifact.mjs validate artifacts/report.recipe.json`, not
`validate /abs/path/report.recipe.json`). The project root is your current
working directory; an absolute Recipe path, or a path whose real location
resolves outside the cwd, fails with `recipe must live inside the project
root` — even when the file is genuinely under the project tree, if your cwd
isn't that tree's root. `cd` into the project first.


Encrypted Recipes name a local password credential:

```json
{
  "encrypted": true,
  "passwordCredential": "release-report"
}
```

The CLI resolves it from `--password`,
`OPEN_ARTIFACTS_PASSWORD_RELEASE_REPORT`, or
`credentials.namedPasswords.release-report`. Passwords never enter a Recipe or
Manifest.

## Commands

```bash
node scripts/artifact.mjs validate path/to/report.recipe.json
node scripts/artifact.mjs build path/to/report.recipe.json \
  --output .artifacts/previews/report.html --standalone
node scripts/artifact.mjs create path/to/report.recipe.json
node scripts/artifact.mjs update <artifact-id>
```

`validate` writes nothing. `build` writes only the explicitly requested
preview/export. `create` and `update` build in memory and persist Manifest state
only after the service accepts the publish.

Use `migrate <artifact-id>` to create Recipe sources for a legacy Manifest v1
entry without publishing. Calling `update` on a legacy entry performs this
migration automatically, then publishes the generated Recipe once.
