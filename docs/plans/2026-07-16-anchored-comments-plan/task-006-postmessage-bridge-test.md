# Task 006: postMessage bridge allowlist + source-identity tests (RED)

**depends-on**: task-005-host-frame-split-impl

## Description

Write failing tests for the bridge: the host injects a message handler that (a) drops messages whose `event.source` is not the artifact frame, (b) maps only the fixed allowlisted types to fixed actions and ignores unknown types / attacker URLs, and (c) exposes the fixed `type → {method, path}` route table keyed on the serve-time artifact id. Verify by asserting the generated host/frame scripts contain the guard structure and the fixed route table (and, where a pure handler is extracted, unit-test it directly).

## Execution Context

**Task Number**: 006 of 011 (test)
**Phase**: Viewer split
**Prerequisites**: task-005-host-frame-split-impl committed.

## BDD Scenario

```gherkin
Scenario: The host relays comment reads and writes for the air-gapped frame
  Given the artifact frame has "connect-src 'none'" and an opaque origin
  When the frame needs to persist a new comment
  Then the frame sends an "oa:anchor:new" message to the host over postMessage
  And the host page makes the create request and posts the refreshed list back to that frame window only

Scenario: The host ignores a postMessage from an unexpected window
  Given a nested frame inside the artifact posts a message whose type is "oa:anchor:new"
  When the host receives that message from a window that is not the artifact frame
  Then the host makes no network request
  And no reply is sent

Scenario: The host cannot be turned into an open proxy
  Given the artifact frame contains hostile script
  When that script posts a message asking the host to fetch "https://attacker.example/steal"
  Then the host ignores the supplied URL
  And any request the host makes targets only "/api/artifacts/art_1/comments"
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (test-only): assertions over the generated host/frame bridge scripts and/or a unit-tested pure `bridgeRoute(type, id, commentId?)` helper.

**Consumes** (from task 006-impl):
- Host bridge message allowlist: `oa:ready`, `oa:anchor:new`, `oa:anchor:open`.
- Host→frame: `oa:theme`, `oa:arm`, `oa:comments`.
- `bridgeRoute(type: string, id: string, commentId?: string): { method: string; path: string } | null` (pure, if extracted for testability).

**Global Constraints respected**: `event.source === frame.contentWindow` guard; no `fetch(msg.url)`; host→frame carries only non-sensitive data.

## Files to Modify/Create

- Modify: `tests/worker/viewer.test.ts` (assert bridge script structure in the served host page: source-identity guard, fixed route table, unknown-type drop)
- Optionally create: `tests/worker/bridge.test.ts` if a pure `bridgeRoute` helper is extracted.

## Steps

### Step 1: Implement Test (Red)
- Assert the host page script contains an `event.source !== ` identity guard and a route table producing only `/api/artifacts/${id}/comments` paths (no `msg.url` interpolation).
- If `bridgeRoute` is extracted: assert it returns null for unknown types, `POST /api/artifacts/art_1/comments` for `oa:anchor:new`-derived create, and never a non-`/api/artifacts/art_1/...` path.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` (or `bridge.test.ts`) MUST FAIL.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
```

## Success Criteria

- Bridge tests exist and fail before 006-impl.
