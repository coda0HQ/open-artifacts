# Anchored Comments — Design

Human-facing, *anchored* commenting on the artifact viewer in two modes: **Figma-style
point pins** on canvas artifacts, and **Notion-style text-range selection** on normal
HTML/Markdown pages. Extends the Phase-1 read-only comment thread into an interactive,
spatially/textually anchored one — the first interactive-write feature on the viewer.

## Context

Open Artifacts serves self-contained HTML/Markdown pages in a deliberately **air-gapped**
sandbox (`sandbox allow-scripts`, opaque origin, `default-src 'none'`, `connect-src 'none'`,
no storage). Phase 1 of issue #5 (`git 000ea44`) landed durable per-artifact comment
threads, but only **read-only**: the whole viewer — service header, comment drawer, and
artifact body — is one sandboxed document (`src/wrap.ts:497-561`, served `sandbox:true` at
`src/index.ts:164`), and under `connect-src 'none'` (`src/wrap.ts:59`) a viewer **cannot
POST**. The drawer merely renders comments **inlined at serve time** (`src/index.ts:131`,
`commentsDrawerHtml` `src/wrap.ts:211-230`); posting works only from external API clients
(`POST /api/artifacts/:id/comments`, `src/api.ts:372-394`).

The request — interactive posting from the viewer, plus two anchoring modes — is therefore
**not an extension of the single-document chrome**. It requires the outer-host-page +
inner-sandboxed-iframe split that Phase 1 explicitly deferred (`src/wrap.ts:202-210`) and
that issue #5 names as its "architectural tension" resolution (option 1: collab chrome
outside the sandbox, bridged via `postMessage`). This design delivers that split as the
foundation, plus the two anchoring models on top. Realtime fan-out (Phase 2) and voice
(Phase 3) stack on this foundation later and are **out of scope**.

## Discovery Results

- **The split already exists for one path.** The encrypted-unlock page is served
  *un-sandboxed* (`htmlHeaders(false)`, `src/index.ts:148`) and embeds the decrypted
  artifact in a sandboxed child `<iframe id="oa-frame" sandbox="allow-scripts …"
  srcdoc=…>` (`src/wrap.ts:731`). Generalizing this one branch to *all* artifacts **is**
  the whole architectural change.
- **CSP is an HTTP header, never a `<meta>` tag** (`src/wrap.ts:78-88`); the `sandbox`
  directive is header-only. A `srcdoc` child gets its opaque origin from the iframe
  `sandbox=` attribute only and **inherits** the parent CSP; a `src="/a/:id/frame"`
  sub-route child gets an **independent, authoritative** HTTP CSP header (incl. its own
  `sandbox` directive) and does not double the ≤4 MiB payload into the host page.
- **The canvas runtime is a closed IIFE with no public API** (`canvas.md:554-1280`): no
  globals, no events. Camera state (`view = {x,y,k}`) lives in the closure and is written
  out only as inline custom properties `--tx/--ty/--k` on `#canvas` by `paint()`
  (`canvas.md:647-651`), consumed by `.oa-plane` (`transform: translate(--tx,--ty)
  scale(--k); transform-origin: 0 0`, `canvas.md:109-114`). A comment bridge must read the
  camera from the DOM once and render pins as **passive CSS children of the plane** — the
  plane then pans/zooms them on the GPU for free.
- **The canvas already documents a "Figma comment pin" idiom**: the collapsed-note-chip
  transform `scale(1/var(--k)) translate(-50%,-50%)` (`canvas.md:249-254`) gives constant
  on-screen size, center-pinned, at any zoom. Comment pins reuse it verbatim.
- **The comment table + API + drawer already exist** (`src/store.ts:71-80`,
  `src/api.ts:364-394`, `src/domain.ts:67-78,313-342`). This design **extends** them
  (adds an `anchor` column, a delete-token column, a `DELETE` route, anchor validation) —
  it does not replace them.
- **No prior design or memory** on this topic (docs index empty).

## Glossary

Canonical labels (reconciled across research streams; prefer terms already in the codebase):

| Term | Definition |
|---|---|
| **host page** | The outer, **normal-origin, un-sandboxed** document served at `/a/:id`. Holds the chrome, `localStorage` identity, and the **only** network capability (fetch `/api/*`). Embeds the artifact in the frame. |
| **artifact frame** | The inner `<iframe>` that renders the artifact body. Sandboxed (`allow-scripts`, no `allow-same-origin` in the strict default), opaque origin, `connect-src 'none'` — unchanged air-gap. |
| **bridge** | The small inline scripts (one on each side) that exchange a **fixed allowlisted** message set between host page and artifact frame via `postMessage`. Not a generic proxy. |
| **anchor** | The stored target a comment points at. One nullable JSON value: `null` (unanchored) \| `{mode:"point",…}` \| `{mode:"text",…}`. Carries `anchorVersion`. |
| **point mode** | Canvas-only anchor: a world-coordinate point `{x,y}` on `.oa-plane` (integers, zoom/pan-independent). |
| **text mode** | Normal-page anchor: a W3C `TextQuoteSelector` (`quote`+`prefix`+`suffix`) plus a `TextPositionSelector` `start` **hint**. |
| **marker** | The on-screen indicator that renders an anchor. Two kinds: **pin** (point mode) and **highlight** (text mode). |
| **pin** | The point-mode marker — a small constant-size dot placed at a world point, a passive child of `#plane`. |
| **highlight** | The text-mode marker — a restrained `--accent-soft` tint over the anchored text run, drawn via the CSS Custom Highlight API (no DOM mutation of untrusted content). |
| **thread** | The ordered set of comments attached to one anchor, or the page-level (unanchored) set. |
| **compose popover** | The small `fixed` input that appears at a fresh anchor point to type + submit a comment. Lives in the **host page**. |
| **display name** | The viewer's self-chosen author label, kept in host `localStorage`, sent as the existing `author` field. No accounts. |
| **delete token** | A per-comment capability minted on create (like the artifact `writeToken`); its SHA-256 hash is stored server-side, the plaintext returned once and kept in host `localStorage`, authorizing delete-own. |
| **orphaned anchor** | A text anchor whose `quote` no longer resolves against the viewed content. The comment stays listed in the drawer, flagged detached, never dropped. |

## Requirements

Functional (each traced to a source; covered by `bdd-specs.md`):

- **REQ-001** — Two anchoring modes: a **point pin** on canvas artifacts and a **text range**
  on normal pages; a comment MAY also be unanchored (page-level). *(task; issue #5;
  `canvas.md:245`)*
- **REQ-002** — Interactive posting from the viewer: create an anchor, type, submit; the
  comment persists server-side without a reload. *(issue #5 acceptance Scenario 1)*
- **REQ-003** — Persistence + future-viewer visibility: comments and anchors persist to D1
  and are re-inlined for every future viewer at serve time; markers reappear on load with
  no runtime fetch for reads. *(issue #5; `src/index.ts:131`)*
- **REQ-004** — Reuse the Phase-1 drawer as the thread surface; clicking a marker opens that
  anchor's thread in the drawer. *(task)*
- **REQ-005** — Local identity via a self-chosen **display name** in host `localStorage`,
  sent as `author`. No accounts. *(task; issue #5 open question; README)*
- **REQ-006** — Keep the artifact body sandboxed: the frame retains `connect-src 'none'` and
  an opaque origin; all network capability lives in the host page. *(issue #5 Scenario 4;
  PRODUCT.md:49-51)*
- **REQ-007** — Delete-own: an author can delete a comment they posted, authorized by a
  per-comment **delete token**. *(task; issue #5 open question)*
- **REQ-008** — Owner moderation: the artifact owner (holder of the `writeToken`/channel
  token) can delete any comment on their artifact. *(issue #5 open question)*
- **REQ-009** — Anchor markers: a **pin** for point anchors, a **highlight** for text
  anchors, rendered on the artifact surface. *(task; `canvas.md:245-306`)*
- **REQ-010** — Orphaned-anchor handling: a text anchor that no longer resolves is shown in
  the drawer as detached, never silently dropped. *(task)*
- **REQ-011** — Version-drift signal: each anchor records the artifact version it was made
  against; the viewer only anchors when `anchorVersion ≤ viewedVersion` and shows a small
  `· v{n}` tag when they differ. *(task; `src/store.ts` versioning)*
- **REQ-012** — Host/frame split: `/a/:id` becomes the host page; the artifact renders in a
  frame delivered via sub-route `GET /a/:id/frame` (plain) or `srcdoc` (encrypted).
  *(issue #5 architectural tension; `src/index.ts:83-165`)*
- **REQ-013** — postMessage bridge: a fixed allowlist of message types, each mapping to one
  fixed action, authenticated by `event.source` window identity (origin is `"null"`). No
  generic proxy. *(issue #5 Scenario 4)*
- **REQ-015** — Back-compat: legacy Phase-1 unanchored comments (all-NULL anchor) render
  unchanged and are removable only by the owner (no delete token). *(`src/store.ts:71-80`)*
- **REQ-016** — Server-side anchor validation and output escaping: reject non-finite point
  coordinates, over-long `quote`/`prefix`/`suffix`, and anchors over 2 KiB; escape all
  attacker-controlled fields (`author`, `body`, `quote`) where rendered. *(`src/domain.ts:313`)*
- **REQ-017** — Encrypted scope: encrypted artifacts get interactive **unanchored** comments
  only for MVP; anchored modes are **plain-artifact only**, because a text `quote` would
  copy plaintext to the server and break the zero-knowledge guarantee. *(zero-knowledge
  encryption; `src/wrap.ts:650-676`)*

Non-functional:

- **REQ-014** — Design register: every marker, popover, and drawer element is quiet and
  systems-grade, reads in **both themes**, is **keyboard-first** (focus rings via
  `--focus-ring`, drop/select/submit/dismiss without a pointer), uses tokens only, and
  adds no decorative motion. The pin pattern lands in `references/canvas.md`, not per
  artifact. *(PRODUCT.md; `tokens.css`)*
- Sizes: comment body ≤ `MAX_COMMENT_BODY_BYTES` (8 KiB); anchor payload ≤ 2 KiB; artifact
  content ≤ 4 MiB (unchanged). BDD-first; biome; pnpm; both typecheck targets green.

Explicitly **out of scope** (stack on this foundation later): realtime / WebSocket /
Durable-Object live fan-out and presence (**Phase 2**); voice / WebRTC (**Phase 3**);
collaborative editing of artifact content; moderation beyond delete-own + owner-delete;
point pins on *encrypted* canvas artifacts (feasible post-unlock — coords leak nothing —
but deferred to keep MVP tight).

## Rationale

- **Why the split at all.** Interactive posting needs a document that can `fetch` `/api`.
  The artifact must stay air-gapped (untrusted author JS). The only reconciliation is two
  documents: a privileged host page and an air-gapped frame. This is issue #5's mandated
  design and already exists on the encrypted path.
- **Why sub-route delivery for plain, `srcdoc` for encrypted.** A `srcdoc` child cannot
  carry a header `sandbox` directive, *inherits* the host's now-loosened `connect-src`,
  and doubles the ≤4 MiB payload into the host page. A sub-route child reuses today's
  proven plain-artifact CSP header verbatim, is independently cacheable, and keeps the host
  page tiny. Encrypted **must** use `srcdoc` because the server never holds the plaintext.
  Both share one `frameDocument()` builder; only delivery differs.
- **Why pins are passive plane children.** The canvas runtime exposes no API and won't
  notify a bridge. Reading the camera once at create time and letting the plane's own
  GPU transform move the pins means zero polling, zero `requestAnimationFrame`, zero
  runtime changes — the simplest correct design.
- **Why quote-selector text anchoring, hand-rolled.** A `TextQuoteSelector` stores text,
  not geometry, so it is inherently immune to responsive reflow; a position *hint* plus a
  bounded fuzzy fallback buys tolerance to content edits. The established libraries pull in
  diff-match-patch (~50 KB, pathologically slow on the not-found case we hit most) and one
  is archived; a ~150-line inline matcher fits the `connect-src 'none'`, inline-at-serve
  model and keeps the chrome small.
- **Why UI is split (anchoring in frame, thread/compose/network in host).** Pins and
  highlights *must* be captured and drawn inside the frame's coordinate/text space. But the
  thread drawer, the compose input, identity storage, and the network *must* be in the
  host (CSP; and so the user never types comment text into untrusted content, and delete
  tokens never enter the frame). The bridge carries only anchor events, marker-open events,
  a marker-render list of public fields, and theme.
- **Why open posting + local identity.** Matches the README's "no accounts anywhere" and
  Phase-1's open model; the per-comment delete token mirrors the existing `writeToken`
  idiom, giving delete-own with zero identity infrastructure. A `COMMENT_TOKEN` gate
  (parallel to `CREATE_TOKEN`) is noted as a future toggle, unbuilt.

## Detailed Design

The interactive path, end to end:

1. **Serve.** `/a/:id` returns the **host page** (`hostShell()`, normal origin,
   `connect-src 'self'` + `frame-src 'self'`, no `sandbox` directive). It carries the full
   crawler `<head>` (title, `og:*`), the reused comment drawer, the theme toggle, the
   inlined comment thread (first paint), and an `<iframe src="/a/:id/frame">` (plain) or a
   `srcdoc` frame built and injected after client-side decrypt (encrypted).
2. **Frame.** `GET /a/:id/frame` (plain only; 404 for encrypted) returns `frameDocument()`
   — the artifact body + the injected **bridge** script — with today's plain-artifact CSP
   header verbatim (`sandbox allow-scripts`, `connect-src 'none'`, opaque origin).
3. **Detect mode.** The bridge checks for `.oa-plane` with a non-`none` computed transform
   → **point mode** (canvas); otherwise **text mode**.
4. **Render existing markers.** The bridge reads the serve-time-inlined comment list (a
   `data-anchor` attribute per drawer item, mirrored into the frame), and for each anchored
   comment with `anchorVersion ≤ viewedVersion` draws a **pin** (point) or **highlight**
   (text). Point pins are appended to `#plane`; text highlights use the CSS Custom Highlight
   API. Text anchors that don't resolve become **orphaned** (drawer-only).
5. **Author.** The viewer arms the comment tool (chrome toggle), then clicks a canvas point
   or selects text. The bridge computes the anchor (world coords / quote selector) and
   `postMessage`s `oa:anchor:new {anchor, point}` out. The host opens the **compose
   popover** at `point`, prefilled with the saved display name.
6. **Persist.** On submit the host `POST`s `/api/artifacts/:id/comments`
   `{body, author, anchor, anchorVersion}`. The server validates (`validateComment` +
   `validateAnchor`), mints a **delete token**, stores its SHA-256 hash, and returns the
   comment plus the plaintext delete token (201). The host stores the delete token in
   `localStorage` and `postMessage`s the refreshed public list (`oa:comments`) into the
   frame, which draws the new marker.
7. **Open / delete.** Clicking a marker `postMessage`s `oa:anchor:open {ids, point}`; the
   host opens that thread in the drawer. Delete-own sends `DELETE
   /api/artifacts/:id/comments/:commentId` with the stored delete token (or the artifact
   `writeToken` for owner moderation).

**Data model.** One nullable `anchor TEXT` (JSON) column and one `delete_token_hash TEXT`
column added to `comments` via the existing idempotent-ALTER pattern; `null` anchor =
unanchored (Phase-1 rows untouched). Full schema, CSP tables, bridge protocol, anchoring
math, and the file-by-file edit list are in `architecture.md`; the security model,
migration, and performance rules are in `best-practices.md`.

## Risks

- **R1 — web-fonts mode collapses the host↔frame air-gap (highest).** With
  `OPEN_ARTIFACTS_WEB_FONTS=1` (the coda0 default) the frame sandbox gains
  `allow-same-origin` (`src/wrap.ts:66`); a same-origin frame becomes same-origin with the
  privileged host and can reach `window.parent`. **Mitigation:** for MVP, ship the split
  with the strict default (web-fonts off) where the frame is opaque and the air-gap holds;
  gate the web-fonts+split combination behind a concrete pre-merge test that fetches
  `/a/:id/frame` in web-fonts mode and asserts a `data:`-only font still renders **with
  `allow-same-origin` removed** — if it does, remove `allow-same-origin` from the framed
  child permanently; if not, serve the frame from a distinct `sandbox.` origin. Do not ship
  the split with `allow-same-origin` on a same-origin frame.
- **R2 — a `srcdoc` frame inherits the loosened host CSP.** The encrypted frame's `srcdoc`
  would inherit the host's `connect-src 'self'`. **Mitigation:** stamp an explicit
  `<meta http-equiv="Content-Security-Policy" content="…connect-src 'none'…">` into the
  `frameDocument` used for `srcdoc`, so the inner doc re-asserts `connect-src 'none'`
  regardless of inheritance.
- **R3 — layout shift from single-scroll to frame-scroll.** After the split the frame owns
  its own scroll under a fixed host header. **Mitigation:** position the iframe at
  `top: var(--oa-header-h); inset-inline: 0; bottom: 0` (not `inset: 0`) so the fixed
  header never overlaps frame content; update the `LAYOUT_SCRIPT` sticky-rewrite tests.
- **R4 — text `quote` leaks plaintext on encrypted artifacts.** **Mitigation:** reject
  `mode:"text"` anchors for encrypted artifacts server-side and never arm text mode in an
  encrypted frame (REQ-017); encrypted gets unanchored + (future) point pins only.
- **R5 — spam on open posting.** **Mitigation:** enforce a per-artifact host-side create
  throttle (reject a second create within 1.5 s or while one is in flight) plus a
  server-side per-IP token-bucket of 30 comments/10 min on `POST /comments`, above the
  existing `content-length` precheck; document `COMMENT_TOKEN` as the hard gate for closed
  instances.
- **R6 — XSS via comment fields rendered client-side.** **Mitigation:** build all
  client-rendered comment DOM with `textContent` only (never `innerHTML`) for `author`,
  `body`, and `quote`; keep `escapeHtml` on the server-inlined first-paint thread; add a
  test posting `<img src=x onerror=…>` as author and asserting it renders as text.

## Design Documents

- [`bdd-specs.md`](./bdd-specs.md) — Gherkin scenarios (happy path, edge, error), tagged to REQ IDs.
- [`architecture.md`](./architecture.md) — host/frame split, delivery, CSP tables, bridge protocol, anchoring math, data model, file-by-file edits.
- [`best-practices.md`](./best-practices.md) — security, migration, performance, code quality, pitfalls.
