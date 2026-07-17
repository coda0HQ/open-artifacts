# Anchored Comments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Load `superpowers:executing-plans` skill using the Skill tool to implement this plan task-by-task.

**Goal:** Add human-facing anchored commenting to the artifact viewer — Figma-style point pins on canvas artifacts and Notion-style text-range selection on normal pages — by splitting the viewer into a privileged host page and an air-gapped artifact frame.

**Architecture:** `/a/:id` becomes a normal-origin **host page** (drawer, compose popover, identity, the only `fetch`); the artifact renders in a sandboxed **artifact frame** (`connect-src 'none'`, opaque origin) delivered via sub-route `/a/:id/frame` (plain) or `srcdoc` (encrypted). A fixed-allowlist `postMessage` bridge connects them. Comments gain a nullable `anchor` JSON column (point world-coords / text quote-selector) plus a per-comment delete token.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + D1 + R2, vitest (cloudflare pool + node), Biome, pnpm.

**Design Support:**
- [BDD Specs](../2026-07-16-anchored-comments-design/bdd-specs.md)
- [Architecture](../2026-07-16-anchored-comments-design/architecture.md)
- [Best Practices](../2026-07-16-anchored-comments-design/best-practices.md)

## Context

Phase 1 of issue #5 landed durable but **read-only** comment threads: the whole viewer is one sandboxed document under `connect-src 'none'`, so a viewer cannot POST and the drawer only renders comments inlined at serve time. Interactive, anchored commenting requires the outer-host-page + sandboxed-iframe split that Phase 1 deferred (`src/wrap.ts:202-210`) and issue #5 mandates. This plan delivers that split plus the two anchoring models. Realtime fan-out (Phase 2) and voice (Phase 3) are out of scope.

| Aspect | Current State | Target State |
|--------|--------------|--------------|
| `/a/:id` document | one sandboxed doc (chrome + body), `connect-src 'none'` | normal-origin host page embedding a sandboxed artifact frame |
| Artifact delivery | inlined into the sandboxed `/a/:id` doc | plain → sub-route `/a/:id/frame`; encrypted → `srcdoc` after decrypt |
| Comment posting | external API clients only (viewer cannot fetch) | interactive from the host page; frame relays via `postMessage` |
| Comment anchor | none (flat page-level thread) | nullable `anchor` JSON: point world-coords or text quote-selector |
| Comment deletion | none | delete-own via per-comment delete token; owner via write token |
| `comments` schema | `id, artifact_id, author, body, created_at` | + nullable `anchor TEXT`, `delete_token_hash TEXT` |

## Global Constraints

- **Security**: the artifact frame keeps `connect-src 'none'` and an opaque origin (no `allow-same-origin` on a same-origin frame — see R1); host→frame `postMessage` carries only non-sensitive data (theme, arm state, public comment fields); delete tokens and write tokens never cross into the frame.
- **Security**: all attacker-controlled comment fields (`author`, `body`, `anchor.quote`) are escaped where rendered — `escapeHtml` on server-inlined first paint, `textContent`-only (never `innerHTML`) on client-rendered items.
- **Security**: anchors are validated server-side (`Number.isFinite` point coords; `quote` ≤ 1000, `prefix`/`suffix` ≤ 32; whole anchor ≤ 2 KiB); text-mode anchors are rejected for encrypted artifacts (plaintext-leak guard).
- **Compatibility**: legacy Phase-1 comments (NULL `anchor`, NULL `delete_token_hash`) render unchanged and are removable only by the artifact owner; schema migrations use the idempotent-ALTER pattern (`src/store.ts:87`).
- **Compatibility**: both typecheck targets stay green (`tsconfig.json` Worker + `tsconfig.cli.json` CLI); `pnpm check` (biome) clean; `.feature` files stay biome-excluded.
- **Design**: markers, compose popover, and drawer use `tokens.css` tokens only, read in both themes, expose visible focus rings, and add no decorative motion; the canvas pin recipe lands in `references/canvas.md`, never as a per-artifact patch.
- **Performance**: canvas pins are passive plane children (no camera polling / rAF loop); text re-anchoring runs once per load behind `requestIdleCallback`.
- **Forbidden**: no external runtime dependency in the viewer (no CDN/npm — CSP forbids it); no `any` casts; no implementation logic that widens the frame CSP.

## Execution Plan

```yaml
tasks:
  - id: "001-test"
    subject: "Anchor model + validation tests (domain)"
    slug: "anchor-model-test"
    type: "test"
    depends-on: []
  - id: "001-impl"
    subject: "Anchor type, validateAnchor, extend CommentMeta/CommentInput"
    slug: "anchor-model-impl"
    type: "impl"
    depends-on: ["001-test"]
  - id: "002-test"
    subject: "Comment store anchor + delete-token tests (D1)"
    slug: "comment-store-test"
    type: "test"
    depends-on: ["001-impl"]
  - id: "002-impl"
    subject: "ALTER migrations, anchor persistence, getComment/deleteComment"
    slug: "comment-store-impl"
    type: "impl"
    depends-on: ["002-test"]
  - id: "003-test"
    subject: "POST /comments anchor + delete-token + encrypted-text-reject tests"
    slug: "comment-create-api-test"
    type: "test"
    depends-on: ["002-impl"]
  - id: "003-impl"
    subject: "POST /comments: accept anchor, mint delete token, reject encrypted text"
    slug: "comment-create-api-impl"
    type: "impl"
    depends-on: ["003-test"]
  - id: "004-test"
    subject: "DELETE /comments/:commentId authorization tests"
    slug: "comment-delete-api-test"
    type: "test"
    depends-on: ["002-impl", "003-impl"]  # serializes src/api.ts + comments.test.ts (003 before 004)
  - id: "004-impl"
    subject: "DELETE /comments/:commentId: delete-own token + owner write-token"
    slug: "comment-delete-api-impl"
    type: "impl"
    depends-on: ["004-test"]
  - id: "005-test"
    subject: "Host/frame split CSP + route tests"
    slug: "host-frame-split-test"
    type: "test"
    depends-on: []
  - id: "005-impl"
    subject: "hostShell/frameDocument, host CSP, /a/:id/frame route, unlockShell fix"
    slug: "host-frame-split-impl"
    type: "impl"
    depends-on: ["005-test"]
  - id: "006-test"
    subject: "postMessage bridge allowlist + source-identity tests"
    slug: "postmessage-bridge-test"
    type: "test"
    depends-on: ["005-impl"]
  - id: "006-impl"
    subject: "Bridge: fixed message allowlist, source-identity auth, theme/arm/comments"
    slug: "postmessage-bridge-impl"
    type: "impl"
    depends-on: ["006-test"]
  - id: "007-test"
    subject: "Canvas point-pin coord math + render tests"
    slug: "canvas-pins-test"
    type: "test"
    depends-on: ["006-impl"]
  - id: "007-impl"
    subject: "Canvas detect, world-coord capture, .oa-cm-pin render, canvas.md recipe"
    slug: "canvas-pins-impl"
    type: "impl"
    depends-on: ["007-test"]
  - id: "008-test"
    subject: "Text quote-selector build + re-anchor matcher tests"
    slug: "text-anchoring-test"
    type: "test"
    depends-on: ["006-impl"]
  - id: "008-impl"
    subject: "Text selection capture, quote selector, re-anchor matcher, highlight, orphan"
    slug: "text-anchoring-impl"
    type: "impl"
    depends-on: ["008-test", "007-impl"]  # serializes src/wrap.ts (007 before 008)
  - id: "009-test"
    subject: "Compose popover + create-flow + identity tests"
    slug: "compose-create-ui-test"
    type: "test"
    depends-on: ["003-impl", "006-impl"]
  - id: "009-impl"
    subject: "Compose popover, display-name identity, POST, optimistic render, delete-token store"
    slug: "compose-create-ui-impl"
    type: "impl"
    depends-on: ["009-test", "008-impl"]  # serializes src/wrap.ts (008 before 009)
  - id: "010-test"
    subject: "Drawer open, delete UI, version-drift, orphan-listing, back-compat tests"
    slug: "drawer-delete-drift-test"
    type: "test"
    depends-on: ["004-impl", "009-impl"]
  - id: "010-impl"
    subject: "Marker-open drawer, delete controls, drift tag, orphan + legacy render"
    slug: "drawer-delete-drift-impl"
    type: "impl"
    depends-on: ["010-test"]
  - id: "011-test"
    subject: "Design-register + XSS render tests (both themes, focus, escaping)"
    slug: "design-register-test"
    type: "test"
    depends-on: ["007-impl", "008-impl", "009-impl", "010-impl"]
  - id: "011-impl"
    subject: "Token-only marker/popover/drawer styling, focus rings, textContent escaping"
    slug: "design-register-impl"
    type: "impl"
    depends-on: ["011-test"]
```

**Task File References (for detailed BDD scenarios):**
- [Task 001 test: Anchor model tests](./task-001-anchor-model-test.md) · [impl](./task-001-anchor-model-impl.md)
- [Task 002 test: Comment store tests](./task-002-comment-store-test.md) · [impl](./task-002-comment-store-impl.md)
- [Task 003 test: Comment create API tests](./task-003-comment-create-api-test.md) · [impl](./task-003-comment-create-api-impl.md)
- [Task 004 test: Comment delete API tests](./task-004-comment-delete-api-test.md) · [impl](./task-004-comment-delete-api-impl.md)
- [Task 005 test: Host/frame split tests](./task-005-host-frame-split-test.md) · [impl](./task-005-host-frame-split-impl.md)
- [Task 006 test: postMessage bridge tests](./task-006-postmessage-bridge-test.md) · [impl](./task-006-postmessage-bridge-impl.md)
- [Task 007 test: Canvas pins tests](./task-007-canvas-pins-test.md) · [impl](./task-007-canvas-pins-impl.md)
- [Task 008 test: Text anchoring tests](./task-008-text-anchoring-test.md) · [impl](./task-008-text-anchoring-impl.md)
- [Task 009 test: Compose/create UI tests](./task-009-compose-create-ui-test.md) · [impl](./task-009-compose-create-ui-impl.md)
- [Task 010 test: Drawer/delete/drift tests](./task-010-drawer-delete-drift-test.md) · [impl](./task-010-drawer-delete-drift-impl.md)
- [Task 011 test: Design register tests](./task-011-design-register-test.md) · [impl](./task-011-design-register-impl.md)

## BDD Coverage

All 27 design scenarios are covered. Primary task per scenario:

| Design scenario (bdd-specs.md) | Task |
|---|---|
| Host page & frame different security envelopes | 005 |
| Frame sub-route refuses encrypted plaintext | 005 |
| Host page carries crawler metadata | 005 |
| Post point-anchored comment on canvas | 007 (capture/render) + 009 (compose/persist) |
| Pin stays constant size while zooming | 007 |
| Post text-range comment on normal page | 008 (capture/render) + 009 (compose/persist) |
| Duplicated quote disambiguated by context | 008 |
| Clicking a marker opens thread in drawer | 010 (+006 bridge) |
| Author name from saved display name | 009 |
| Persisted anchored comment reappears | 002 (store) + 003 (create) |
| Host relays reads/writes for air-gapped frame | 006 |
| Host ignores postMessage from unexpected window | 006 |
| Host cannot be an open proxy | 006 |
| Text anchor no longer matches → orphaned, listed | 008 (matcher) + 010 (listing) |
| Comment against newer version not anchored | 010 |
| Delete your own comment with delete token | 004 (+010 UI) |
| Delete with wrong token rejected | 004 |
| Owner moderates with write token | 004 |
| Delete for a different artifact → not found | 004 |
| Non-finite point coordinate rejected | 001 |
| Quote over 1000 chars rejected | 001 |
| Anchor JSON over 2 KiB rejected | 001 |
| Body over 8 KiB rejected | 003 |
| Attacker markup renders as text | 010 (client render) + 011 (both-theme render) |
| Encrypted accepts unanchored, rejects text anchor | 003 (+005 frame 404) |
| Legacy Phase-1 comment renders, owner-removable | 010 (+004 owner delete) |
| Markers/popover/drawer both themes + keyboard | 011 |

## Dependency Chain

```
Each [NNN] is a Red→Green pair (-test, then the -impl that depends on it).
Two spines run in parallel, then converge; src/wrap.ts and src/api.ts writers
are linearized by the file-conflict serialization edges.

  DATA / API SPINE                       HOST / FRAME SPINE
  ────────────────                       ──────────────────
  [001] anchor-model  (domain.ts)        [005] host-frame-split (wrap.ts,index.ts)
        │                                      │
        ▼                                      ▼
  [002] comment-store (store.ts)         [006] postmessage-bridge (wrap.ts)
        │                                      │
        ▼                                      ▼
  [003] comment-create-api (api.ts)      [007] canvas-pins (wrap.ts, canvas.md)
        │                                      │
        ▼  (004-test dep 003-impl)            ▼  (008-impl dep 007-impl)
  [004] comment-delete-api (api.ts)      [008] text-anchoring (wrap.ts)
        │                                      │
        │                                      ▼  (009-impl dep 008-impl;
        │                                      │   009-test dep 003-impl,006-impl)
        └────────────────────────────────►[009] compose-create-ui (wrap.ts)
                                               │
                                               ▼  (010-test dep 004-impl,009-impl)
                                         [010] drawer-delete-drift (wrap.ts)
                                               │
                                               ▼  (011 dep 007,008,009,010-impl)
                                         [011] design-register (wrap.ts, canvas.md)

Serialization edges added by the file-conflict review (single-writer files):
  004-test → 003-impl   (src/api.ts + tests/worker/comments.test.ts: 003 before 004)
  008-impl → 007-impl   (src/wrap.ts: 007 before 008)
  009-impl → 008-impl   (src/wrap.ts: 008 before 009)
```

**Analysis**:
- Strict DAG — no circular dependencies (DEP-01 PASS); all `depends-on` resolve (DEP-02 PASS).
- Parallel spines: Data/API (001→002) and Host/Frame (005→006) advance concurrently until they converge at 009 (which needs 003-impl for the create API and the bridge/anchoring runtime).
- After the serialization edges, every `src/wrap.ts` write is ordered `005→006→007→008→009→010→011`, and the `src/api.ts`/`comments.test.ts` writes are ordered `003→004`.
- Every impl depends on its paired same-NNN test (Red→Green, TEST-01 PASS).
- Critical path (~7 pair-levels): `005→006→007→008→009→010→011`.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-07-16-anchored-comments-plan/`. Load `superpowers:executing-plans` skill using the Skill tool — it orchestrates per-batch sub-agent coordinators through the full Phase 1-6 pipeline.
