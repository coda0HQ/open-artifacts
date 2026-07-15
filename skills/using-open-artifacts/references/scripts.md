# Runtime libraries (opt-in, jsdelivr CDN)

This is the reference for the opt-in runtime-library surface — currently just
[mermaid](https://mermaid.js.org/). It sits beside `design.md`'s visual-material
guidance (SVG diagrams/charts as the CSP-clean default). Reach for an inline
SVG first; reach for mermaid when a diagram needs many variants the author will
iterate on, or when the source is authored as text and rendering to SVG by hand
is impractical.

**Why CDN-direct, not a same-origin proxy like fonts?** Fonts proxy through
`/fonts/<slug>` because font *bytes* are passive — the Worker can fetch and
cache them server-side with no execution risk. Scripts execute, so a Worker-side
proxy would gain nothing the CDN doesn't already provide (jsdelivr is a stable,
cached CDN) while adding a maintenance surface. Instead the browser loads the
allowlisted package directly from jsdelivr, and the build gate (not a proxy)
enforces which package/version/path may load.

## Opt-in caveat (read first)

Runtime libraries only load on deploys that set the Worker env var
`OPEN_ARTIFACTS_WEB_FONTS="1"` — the same toggle as web fonts. On a deploy that
has not opted in:

- `script-src` stays `'unsafe-inline'` (no `cdn.jsdelivr.net`), so the
  `<script src>` is blocked by the CSP and the library never loads,
- the sandbox keeps its opaque origin.

The flag's trade-off (documented in `design.md`'s Hard constraints) is real for
scripts: it adds `allow-same-origin`, so a malicious artifact on such a deploy
can read the host origin's `localStorage`/`cookies`, and the loaded library
executes third-party code direct from jsdelivr. Two mitigations keep it bounded:

- the **allowlist** — only `mermaid` is loadable; any other `<script src>` (or
  any other jsdelivr package) is rejected by the build gate at author time,
- **version pinning** — the URL pins a major or exact version, so a supply-chain
  bump under the same major can shift behavior but never silently introduce a
  new package.

If the deploy will ever run untrusted artifacts, leave the flag unset.

## The contract

Declare a library by writing one `<script src>` tag in the body fragment,
pointing at jsdelivr:

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<pre class="mermaid">
flowchart LR
  A[Author] --> B(Build gate)
  B --> C{jsdelivr + allowlisted?}
  C -->|yes| D[(browser loads from jsdelivr)]
  C -->|no| E[rejected]
</pre>
```

Then initialize from the scripts slot (`document.fragments.scripts`):

```js
import mermaid from "mermaid"; // not needed — mermaid attaches to window
await window.mermaid.run({ querySelector: ".mermaid" });
```

In practice mermaid is a UMD bundle that defines `window.mermaid`, so call
`mermaid.initialize({ startOnLoad: true })` before the diagrams, or
`await mermaid.run()` after. Put that call in the scripts slot — **not** in the
body. Inline `<script>` (no `src`) is still forbidden in the body.

**URL grammar:** `https://cdn.jsdelivr.net/npm/<pkg>@<version>/<path>`

- `pkg` — an allowlisted package name. Today: `mermaid`.
- `version` — a jsdelivr version range: a major pin (`11`) or an exact
  `major.minor.patch` (`11.4.0`). Major pins follow jsdelivr's semver range.
- `path` — the file under the package (the canonical minified dist path).

Examples:
`https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`,
`https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.min.js`.

The browser fetches the bundle directly from jsdelivr (the opt-in CSP adds
`cdn.jsdelivr.net` to `script-src`); there is no same-origin proxy. The build
gate restricts the URL to the allowlisted package, so an artifact cannot load
arbitrary npm JS — only the named package's versioned files.

The Worker resolves the slug to `https://cdn.jsdelivr.net/npm/<pkg>@<ver>/dist/<pkg>.min.js`
*server-side*, fetches it *outside the sandbox*, caches the bytes in R2 under
`scripts/<slug>.js`, and serves it same-origin. No third-party host ever appears
in the artifact CSP; `connect-src` stays `'none'`. First load lazily
materializes; subsequent loads serve from R2 / browser cache.

## Discipline

- **One library, pinned.** Mermaid is ~3.5 MB minified. Don't load it for a
  single small diagram — hand-draw the SVG (see `design.md`'s visual-material
  section). Load it when there are many diagrams or the source is text-authored.
- **Initialize once.** Call `mermaid.initialize`/`mermaid.run` from the scripts
  slot, after the `<script src>` tag in document order. The jsdelivr bundle is
  not a module; it attaches to `window`.
- **Theme the diagrams.** Mermaid reads CSS variables for theming; set
  `--mermaid-*` tokens (or pass `themeVariables` to `initialize`) in both the
  light and dark `:root` blocks so diagrams match the direction. Default mermaid
  theme is light-only and will look wrong in a dark block.
- **Keep the fallback honest.** If the deploy hasn't opted in, the jsdelivr
  `<script src>` is blocked by the CSP and `window.mermaid` is undefined — guard
  the init call (`if (window.mermaid) ...`) so the page degrades to the raw
  `<pre>` source rather than throwing.
- **Syntax is validated at build time.** Every `<pre class="mermaid">` is
  parsed by the vendored mermaid + linkedom bundle during `validate`/`publish`;
  a syntax error fails the build with mermaid's message (line number + expected
  token). So a broken diagram never ships — fix the source and re-validate. If
  the `vendor/mermaid/` bundles are absent (skill installed before this gate),
  the gate warns and skips rather than blocking; run
  `node scripts/vendor-mermaid.mjs` in the open-artifacts repo to (re)generate.

## Adding a package

The allowlist is intentional, not a config file. To add a library:

1. Add the package name to `ALLOWED_SCRIPT_PACKAGES` in
   `skills/using-open-artifacts/scripts/lib/validate.mjs`.
2. Document the canonical minified dist path here.
