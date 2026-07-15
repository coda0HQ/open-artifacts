# Best Practices — Anchored Comments

## Security

### postMessage bridge

- **Authenticate by window identity, not origin.** A sandboxed frame without
  `allow-same-origin` has an opaque origin serialized as `"null"`; every sandboxed frame
  reports the same string, so origin allowlisting is useless. The host's first check is
  `if (event.source !== frame.contentWindow) return;`. The frame's first check is
  `if (event.source !== window.parent) return;`.
- **Fixed type → action table.** Each message `type` maps to exactly one hardcoded action.
  The frame never supplies a URL, method, id, or header; the host interpolates only the
  serve-time-baked artifact `id` and a `commentId` re-validated as `^[a-z0-9]+$` and
  length-bounded before use. This closes SSRF / open-proxy.
- **`targetOrigin "*"` is required and safe here** because the child origin is `"null"`
  (you cannot pass `"null"` as targetOrigin). It is safe only because the host posts to the
  specific `frame.contentWindow` reference it created (never `window.parent`/`opener`/
  broadcast) and sends **only non-sensitive data** — theme, arm state, and a public comment
  list of `{id, anchor, author, body, createdAt}`. Delete tokens, write tokens, and any
  other capability never cross host→frame.
- **Body allowlist.** The create request body is whitelisted to
  `{author, body, anchor, anchorVersion}`; no arbitrary field passthrough.

### XSS

`author`, `body`, and `anchor.quote` are all attacker-controlled and are rendered into the
viewer.

- **Server-inlined first paint** (the thread stamped into `hostShell` at serve time)
  continues to use `escapeHtml` (`src/wrap.ts:5-12`), body under `white-space:pre-wrap`.
- **Client-rendered items** (built by the host from an `/api` list response) must be
  constructed with `createElement` + `textContent` only — never `innerHTML` — for
  `author`, `body`, and `quote` (shown in the orphaned-comment label). The delete affordance
  is a button whose `commentId` is a validated data attribute, never string-built HTML.

### Anchor validation (server, in `validateAnchor`)

- `mode` must be exactly `"point"` or `"text"` → else 400.
- **point:** `x`, `y` must each satisfy `Number.isFinite` → rejects `NaN`, `Infinity`, and
  the strings `"Infinity"`/`"NaN"`. (World coords are unbounded integers; do not clamp to a
  range — a valid canvas point can be negative or large. Reject only non-finite.)
- **text:** `quote` required, `1 ≤ length ≤ 1000`; `prefix`/`suffix` optional strings each
  `≤ 32`; `start` optional, `Number.isInteger && ≥ 0`.
- `JSON.stringify(anchor).length ≤ 2048` (guards a giant blob slipping under the 8 KiB body
  cap).
- `anchorVersion` a positive integer.
- `anchor` omitted/null → valid unanchored comment.
- **Encrypted rule (R4):** `POST /comments` rejects `mode:"text"` when the artifact is
  encrypted — a text `quote` would copy plaintext to the server and break the zero-knowledge
  guarantee. Encrypted artifacts accept unanchored comments (and, as a future extension,
  point pins, whose coords leak nothing).

### Identity / auth / moderation

- **Open posting, no accounts** (matches Phase-1 and the README). Reads and posts stay open.
- **Display name** in host-page `localStorage` (`oa-comment-name`), sent as `author`; purely
  cosmetic, unverified. The opaque frame has no persistent storage, which is why identity
  lives in the host.
- **Delete-own via per-comment delete token**, mirroring the artifact `writeToken` idiom:
  the server mints a random `deleteToken` on create, stores only `sha256Hex(deleteToken)`
  in `comments.delete_token_hash`, returns the plaintext once in the 201 body; the host
  keeps it in `localStorage` keyed by comment id. `DELETE
  /api/artifacts/:id/comments/:commentId` with `Authorization: Bearer <deleteToken>` loads
  the comment (404 if missing or `comment.artifactId !== id`) and compares
  `timingSafeEqual(await sha256Hex(token), comment.deleteTokenHash)` (the `authorizeWrite`
  primitives, `src/api.ts:84-91`); mismatch → 403.
- **Owner moderation** without accounts: the same `DELETE` route also authorizes if the
  presented token matches the artifact's write/channel token via `authorizeWrite`. Legacy
  Phase-1 comments (`delete_token_hash = NULL`) are removable only this way.
- **Future toggle (do not build):** a `COMMENT_TOKEN` Worker secret gating posting, exactly
  parallel to `CREATE_TOKEN` (`src/api.ts:162-174`) — absent = open.

### Rate limiting (R5)

Host-side: reject a `comments:create` if one is in flight or the previous one was under
1.5 s ago (UX guard against key-repeat/loops). Server-side (authoritative): a per-IP,
per-artifact token bucket of 30 comments per 10 minutes on `POST /comments`, above the
existing `content-length` precheck (`src/api.ts:377-380`).

## Migration

Two idempotent nullable ALTERs appended to `MIGRATIONS` (`src/store.ts:87`):

```js
`ALTER TABLE comments ADD COLUMN anchor TEXT`,
`ALTER TABLE comments ADD COLUMN delete_token_hash TEXT`,
```

Re-run throws `"duplicate column name"`, already swallowed by `isExpectedMigrationError`
(`src/store.ts:113-115`). **No backfill** — legacy rows keep NULLs (unanchored,
owner-removable only), fully back-compatible with Phase-1 comments. The existing
`idx_comments_artifact_created` index (`src/store.ts:78`) still covers the list query; no
new index for MVP.

## Performance

- **Text re-anchoring is O(threads).** Build the artifact's `textContent` once per load
  (single `TreeWalker` pass), then match each text-mode comment against it, seeded from the
  stored `start` hint. Defer the whole pass behind `requestIdleCallback` (the codebase
  already uses this pattern, `src/wrap.ts:304`) so first paint is not blocked; yield between
  batches for large threads. A miss falls back to a bounded fuzzy window, not a whole-doc
  scan every time.
- **Canvas pins cost nothing on pan/zoom.** Pins are passive children of the single
  transformed plane, so the plane's own GPU transform moves them — no `requestAnimationFrame`
  loop, no camera polling, no `MutationObserver`. The camera is read exactly once, at
  create time.
- **Tiny scripts.** The host side and frame side of the bridge are a few hundred bytes each,
  inlined like `THEME_SCRIPT`/`LAYOUT_SCRIPT`; the text matcher is ~150 lines; no external
  dependency (CSP forbids CDNs, and diff-match-patch is oversized and pathologically slow on
  the not-found case — the common republished-and-edited path).

## Code quality

- **Reuse, don't replace.** Extend `COMMENTS_CSS`/`commentsDrawerHtml`/`COMMENTS_SCRIPT`,
  the comment table, and the `/api/.../comments` routes. Keep the diff proportional to two
  new columns, one route, one anchor validator, and the host/frame document split.
- **One `frameDocument()` builder** for both plain (sub-route) and encrypted (`srcdoc`)
  frames — the delivery differs, the inner document does not. Deleting the duplicate
  header/drawer that `unlockShell` currently renders both outside and inside the srcdoc is a
  net simplification.
- **Domain stays pure.** `validateAnchor` lives in `src/domain.ts` with no infrastructure
  import, mirroring `validateEncryption`. Routes orchestrate; the store persists.
- **Biome, pnpm, BDD-first.** New behavior starts as a `tests/features/*.feature` scenario;
  both typecheck targets (`tsconfig.json` Worker + `tsconfig.cli.json` CLI) stay green;
  `.feature` files remain biome-excluded.
- **Design register (REQ-014).** Markers/popover/drawer use tokens only (`--accent`,
  `--accent-soft`, `--surface`, `--border`, `--focus-ring`, `--danger`), read in both
  themes, expose `:focus-visible { box-shadow: var(--focus-ring) }`, and add no decorative
  motion (match the existing single `transform .18s` drawer slide budget). The pin recipe
  lands in `references/canvas.md`, never as a per-artifact patch.

## Common pitfalls

- **Do not put the compose input inside the frame.** Typing comment text into the untrusted
  artifact document lets a hostile artifact keylog it. Compose lives in the host page; the
  frame only reports the anchor and a screen point for popover placement.
- **Do not ship `allow-same-origin` on a same-origin frame (R1).** In web-fonts mode this
  makes the untrusted frame same-origin with the privileged host. Gate the web-fonts+split
  combination behind the pre-merge test in R1 and either drop `allow-same-origin` from the
  framed child or serve the frame from a distinct `sandbox.` origin before enabling it.
- **Do not forget the `<meta>` CSP on the `srcdoc` frame (R2).** A `srcdoc` child inherits
  the host's loosened `connect-src 'self'`; re-assert `connect-src 'none'` inside.
- **Do not point crawlers at `/a/:id/frame` (R4-adjacent).** `og:url` stays `/a/:id`; the
  frame carries no title/og and adds `frame-ancestors 'self'` to block third-party
  deep-linking of the un-chromed frame.
- **Do not gate pins on `CHIP_K`.** Comment pins are always pin-sized and use uncapped
  `1/k`; the note-collapse threshold applies to `.oa-note`, not to purpose-built pins the
  runtime never manages.
- **Do not treat `start` as truth.** It is a search hint only; the quote + context is
  authoritative, so a stale offset can only make anchoring slower, never wrong.
