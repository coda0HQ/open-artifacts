# Architecture — Anchored Comments

## System overview

```
 GET /a/:id ─────────────►  HOST PAGE  (normal Worker origin)
                            • hostShell(): crawler <head>, reused drawer, theme toggle,
                              compose popover, inlined first-paint thread
                            • the ONLY network party: fetch /api/artifacts/:id/comments
                            • identity: localStorage display-name + per-comment delete tokens
                            • bridge (host side): fixed postMessage allowlist
                                  │
                                  │  plain:     <iframe src="/a/:id/frame" sandbox=…>
                                  │  encrypted: <iframe srcdoc=…> injected after decrypt
                                  ▼
 GET /a/:id/frame ───────►  ARTIFACT FRAME  (opaque origin, connect-src 'none')
   (plain only; 404 enc)    • frameDocument(): artifact body + injected bridge
                            • detect mode → render markers (pins in #plane / CSS highlights)
                            • capture anchors (pin drop / text select); never fetches
                            • bridge (frame side): posts anchor/marker events out
```

Two documents, one air-gap boundary. The **host page** is privileged (fetch + storage);
the **artifact frame** is air-gapped exactly as today's single viewer document. They
exchange only a fixed, small set of `postMessage` types (the **bridge**).

This generalizes the pattern that already exists on the encrypted-unlock path
(`src/index.ts:133-149` serves an un-sandboxed host; `src/wrap.ts:731` embeds a sandboxed
`srcdoc` child). The plain path moves from "one sandboxed document" to "host page + framed
sub-route".

## Layering (dependency direction preserved)

The change respects the existing inward-only dependency direction; no inner layer gains an
outward dependency:

- **Domain** (`src/domain.ts`) — pure types + validation. Gains the `Anchor` type and a
  `validateAnchor()` function (a pure discriminated-union validator, sibling of
  `validateEncryption`). Imports nothing from `store`/`api`/`wrap`.
- **Application/routes** (`src/api.ts`) — orchestrates: calls `validateComment`/`validateAnchor`
  (domain) and `store.addComment`/`getComment`/`deleteComment` (infra) through their
  interfaces. Depends inward on domain and on the `ArtifactStore` interface.
- **Infrastructure** (`src/store.ts`) — D1/R2 persistence implementing `ArtifactStore`.
  Adds the two columns, the anchor read/write, and `getComment`/`deleteComment`.
- **Presentation** (`src/index.ts`, `src/wrap.ts`) — serve/compose only. Splits the served
  document into `hostShell()` + `frameDocument()` and injects the bridge scripts.

## Delivery mechanism (per artifact kind)

| | Plain artifact | Encrypted artifact |
|---|---|---|
| Frame delivery | **sub-route** `GET /a/:id/frame`, iframe `src=` | **`srcdoc`**, injected after client-side decrypt |
| Why | own HTTP CSP header (incl. `sandbox` directive), no CSP inheritance, no payload doubling, independently cacheable | server never holds plaintext, so it cannot serve `/frame`; decrypt happens in-browser and fills `srcdoc` |
| `/a/:id/frame` | serves `frameDocument()` with `userContentHeaders({sandbox:true})` | returns **404** |
| Air-gap source | header `sandbox` directive **+** iframe attribute | iframe `sandbox=` attribute **+** stamped `<meta>` CSP (R2) |

Both build the inner document with one shared `frameDocument(options)` builder; only the
delivery differs (HTTP response vs `frame.srcdoc = doc`).

## Two-layer CSP

**Host page `/a/:id`** (new `hostContentSecurityPolicy()` / `hostHeaders()`, sibling of
`userContentHeaders` at `src/wrap.ts:73-88`):

```
default-src 'none';
script-src 'unsafe-inline';
style-src  'unsafe-inline';
img-src    data: blob:;
font-src   data:;
media-src  data: blob:;
connect-src 'self';        ← NEW: the drawer POSTs/GETs /api/artifacts/:id/comments
frame-src  'self';         ← NEW: embed /a/:id/frame
form-action 'none';
base-uri 'none'
                           ← NO sandbox directive → normal origin, holds cross-frame state + theme localStorage
```

**Artifact frame `/a/:id/frame`** — byte-identical to today's plain `/a/:id`
(`src/wrap.ts:47-71`), unchanged:

```
sandbox allow-scripts allow-modals allow-forms allow-popups;   ← opaque origin (strict default)
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none';        ← artifact body stays air-gapped
form-action 'none'; base-uri 'none'; frame-ancestors 'self'
```

`sandbox` **without** `allow-same-origin` forces the opaque origin; `allow-scripts` still
permits JS and `postMessage` (postMessage is not gated by `allow-same-origin`). The host
therefore sees `event.origin === "null"` on frame messages — see the bridge auth model.
The `allow-same-origin` that web-fonts mode adds (`src/wrap.ts:66`) is the subject of R1 and
must not ship on a same-origin frame.

## Bridge protocol

A fixed allowlist; each type maps to exactly one action. Never `fetch(msg.url)`, never a
generic proxy, never `eval`.

**frame → host** (host validates `event.source === frame.contentWindow` first, then `type`):

| Type | Payload | Host action |
|---|---|---|
| `oa:ready` | — | reply with current theme + the public comment list |
| `oa:anchor:new` | `{ anchor, point }` | open the **compose popover** at `point`, prefilled with the display name |
| `oa:anchor:open` | `{ ids, point }` | open the drawer scrolled to that thread |

**host → frame** (`frame.contentWindow.postMessage(msg, "*")` — `"*"` required because the
child origin is `"null"`; only non-sensitive data crosses):

| Type | Payload | Frame action |
|---|---|---|
| `oa:theme` | `{ theme }` | set `<html data-theme>` inside the frame |
| `oa:arm` | `{ mode }` (`"on"`/`null`) | arm/disarm the comment tool |
| `oa:comments` | `{ list }` | (re)render markers from public fields only |

`point` is a frame-viewport screen coordinate; the host maps it to host coordinates by
adding the header offset (the frame is positioned at `top: var(--oa-header-h)`). The
`oa:comments` list carries only `{id, anchor, author, body, createdAt}` — **delete tokens
never cross into the frame** (they live in host storage; the drawer/delete UI is host
chrome). The bridge is ~25 lines split across the two documents, injected as literal inline
`<script>` under `script-src 'unsafe-inline'` (like `THEME_SCRIPT`/`LAYOUT_SCRIPT`,
`src/wrap.ts:555-556`); interpolated values go through `jsonForInlineScript()`
(`src/wrap.ts:21-23`).

## Anchoring mechanics

### Point mode (canvas)

- **Detect:** `const plane = document.querySelector('.oa-plane'); const isCanvas = plane &&
  getComputedStyle(plane).transform !== 'none';` The `!== 'none'` clause excludes the
  compact stacked layout (`< 640px`, `canvas.md:539` sets `transform:none`), where world
  coordinates do not exist.
- **Read camera once (at create):**
  `const m = new DOMMatrixReadOnly(getComputedStyle(plane).transform); const k=m.a, tx=m.e, ty=m.f;`
- **Screen → world** (invert the plane transform; origin at the `.oa-canvas` box because
  `.oa-plane` is `inset:0`):
  `wx = (clientX - rect.left - tx) / k;  wy = (clientY - rect.top - ty) / k;`
  Store `{ x: Math.round(wx), y: Math.round(wy) }` — integer world px, matching frame
  `--x/--y` granularity (`canvas.md:117`). World coords are zoom/pan-independent.
- **Render a pin** — a passive freeform child appended to `#plane`, reusing the
  collapsed-note transform (`canvas.md:249-254`):
  ```css
  .oa-cm-pin { position:absolute; left:calc(var(--x)*1px); top:calc(var(--y)*1px);
    transform: scale(calc(1 / var(--k,1))) translate(-50%,-50%); transform-origin:0 0; z-index:2; }
  ```
  The plane's own `translate…scale` pans/zooms the pin on the GPU; `scale(1/var(--k))`
  cancels zoom so it stays constant size; `translate(-50%,-50%)` after the scale centers it
  in screen px. Unlike `.oa-note`, the pin is **always** pin-sized (decoupled from
  `CHIP_K`) and uses **uncapped** `1/k`. The runtime never touches it.
- **Author gesture:** a chrome comment-tool toggle arms capture; the bridge intercepts the
  next canvas click in the **capture phase** and `stopPropagation()`s it so the runtime's
  `tap()` (`canvas.md:936-953`) never treats it as focus/pan.

### Text mode (normal page)

- **Store** a W3C selector pair:
  ```
  { mode:"text", quote, prefix, suffix, start, anchorVersion }
  ```
  `quote` ≤ 1000 chars (truncate longer selections); `prefix`/`suffix` = 32 chars of
  context each (Hypothesis default, enough to disambiguate repeats); `start` = char offset
  into `root.textContent` (a **hint**, never truth).
- **Re-anchor at render** over `root.textContent`:
  1. exact `prefix+quote+suffix` search → unique hit anchors;
  2. on repeats, keep occurrences whose neighbours match `prefix`/`suffix`, then pick the
     one nearest the `start` hint;
  3. fuzzy fallback: approximate-search `quote` in a ±256-char window around `start`, widen
     to the whole doc, accept if similarity ≥ 0.7 (edit distance ≤ 25% of `quote` length);
  4. otherwise mark **orphaned**.
- Map the resolved char range → a DOM `Range` via a `TreeWalker` over text nodes, then
  highlight with the **CSS Custom Highlight API** (`CSS.highlights.set(name, new
  Highlight(range))`) — no mutation of the untrusted author DOM; `<mark>` fallback only
  where unsupported. Since the anchor stores text (not geometry), responsive reflow needs
  zero handling — offsets recompute live.
- The matcher (~150 lines) is inlined; no runtime dependency (CSP forbids CDNs; the
  library stack pulls in oversized, miss-slow diff-match-patch).

### Version drift

`anchorVersion` (inside the JSON) = the artifact `currentVersion` at create time. The
viewer knows the version it renders. Anchor only when `anchorVersion ≤ viewedVersion`;
render a small `· v{n}` tag when it differs; orphan text that no longer matches. No
cross-version diffing.

## Data structures

`Anchor` (nullable; `null` = unanchored / Phase-1 back-compat):

```ts
type Anchor =
  | { mode: "point"; x: number; y: number; anchorVersion: number }
  | { mode: "text"; quote: string; prefix: string; suffix: string; start: number; anchorVersion: number };
```

`CommentMeta` / `CommentInput` (`src/domain.ts:67-78`) gain `anchor: Anchor | null`.
`delete_token_hash` is **never** serialized to clients. `validateComment` (`src/domain.ts:313`)
calls the new `validateAnchor()`; server-side rules in `best-practices.md`.

## Schema and migration

`comments` table (`src/store.ts:71-80`) gains two nullable columns via the idempotent-ALTER
pattern (`src/store.ts:87-95`, swallowed by `isExpectedMigrationError`):

```sql
ALTER TABLE comments ADD COLUMN anchor TEXT;             -- nullable JSON; NULL = unanchored
ALTER TABLE comments ADD COLUMN delete_token_hash TEXT;  -- nullable; NULL = legacy, owner-removable only
```

Legacy rows read both as NULL → unanchored, not comment-deletable. `addComment`
(`src/store.ts:473`) binds `anchor ? JSON.stringify(anchor) : null` and the delete-token
hash; `listComments`/`toComment` (`src/store.ts:461-513`) `JSON.parse` the anchor. New
`getComment(id)` → `{artifactId, deleteTokenHash}` and `deleteComment(id)`. `delete()`
already cascades comments (`src/store.ts:457`).

## Integration points (file-by-file edits)

- **`src/domain.ts`** — add `Anchor` type; extend `CommentMeta`/`CommentInput` with
  `anchor`; add `validateAnchor()` (discriminated union: `mode` enum; `Number.isFinite`
  point coords; `quote ≤ 1000`, `prefix`/`suffix ≤ 32`, integer `start ≥ 0`; positive-int
  `anchorVersion`; `JSON.stringify(anchor).length ≤ 2048`); wire it into `validateComment`
  (`:313`); export `MAX_COMMENT_QUOTE_LENGTH`, `MAX_COMMENT_QUOTE_CONTEXT_LENGTH`,
  `MAX_ANCHOR_BYTES`, `CURRENT_ANCHOR_VERSION`.
- **`src/store.ts`** — two ALTERs (`:87`); `addComment`/`listComments`/`CommentRow`/
  `toComment` carry `anchor` + delete-token hash; add `getComment`, `deleteComment`.
- **`src/api.ts`** — `POST /artifacts/:id/comments` (`:372`): reject `mode:"text"` on
  encrypted artifacts (R4); mint `deleteToken` via `generateWriteToken()`, store
  `sha256Hex(deleteToken)`, return `{...comment, deleteToken}` (201). Add `DELETE
  /artifacts/:id/comments/:commentId` authorized by `(delete-token hash match) OR
  (authorizeWrite owner match)` (`:55-99`). `GET .../comments` returns `anchor`.
- **`src/wrap.ts`** — add `hostContentSecurityPolicy()`/`hostHeaders()`; extract
  `frameDocument(options)` (artifact body + `MARKDOWN_CSS` + bridge script, no header/
  drawer/og); rename `wrapDocument` → `hostShell(options)` (crawler `<head>`, reused
  `COMMENTS_CSS`+drawer+`headerHtml`, compose-popover CSS, host bridge + upgraded
  `COMMENTS_SCRIPT` doing fetch + optimistic render + frame messaging, and the `<iframe>`);
  fix `unlockShell` to build its `srcdoc` via `frameDocument` (removes today's double
  header/drawer) and stamp the `<meta>` CSP (R2); serve both host branches with
  `hostHeaders()`.
- **`src/index.ts`** — `/a/:id` plain and encrypted branches both return a host page with
  `hostHeaders()`; add `app.get("/a/:id/frame", …)` returning `frameDocument()` with
  `userContentHeaders({sandbox:true, webFonts})`, 404 for encrypted. No `wrangler.jsonc`
  change (`run_worker_first` already globs `/a/*`).
- **`skills/using-open-artifacts/references/canvas.md`** — document the anchored-pin recipe
  beside the note-chip/"Figma comment pin" section (`:245-306`): world-coord capture, the
  `.oa-cm-pin` passive-child pattern, decoupled-from-`CHIP_K`, fixed-not-sticky. "The
  runtime is the design system" (PRODUCT.md) — the pin pattern is a runtime reference, not
  a per-artifact patch.
- **`skills/using-open-artifacts/references/tokens.css`** — no new token; markers/popover
  consume existing `--accent`, `--accent-soft`, `--surface`, `--border`, `--focus-ring`,
  `--danger` (bridged as `--oa-*`).
- **Tests** — `tests/features/anchored-comments.feature` (from `bdd-specs.md`); move the
  `connect-src 'none'`/`sandbox` assertions in `tests/worker/viewer.test.ts` and
  `tests/worker/comments.test.ts` from `/a/:id` to `/a/:id/frame`; assert the host CSP on
  `/a/:id`; add anchor-validation + delete-route + XSS tests.
