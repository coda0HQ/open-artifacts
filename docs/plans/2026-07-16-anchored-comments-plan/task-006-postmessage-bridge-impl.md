# Task 006: postMessage bridge (GREEN)

**depends-on**: task-006-postmessage-bridge-test

## Description

Implement the two-sided bridge: a host-side inline script with a source-identity guard, a fixed message-type allowlist, and a hardcoded `type → {method, path}` route table keyed on the serve-time id; a frame-side inline script that posts anchor/marker events out and applies theme/arm/comments in. Host→frame uses `targetOrigin "*"` and sends only non-sensitive data.

## Execution Context

**Task Number**: 006 of 011 (impl)
**Phase**: Viewer split
**Prerequisites**: task-006-postmessage-bridge-test committed and failing.

## BDD Scenario

```gherkin
Scenario: The host ignores a postMessage from an unexpected window
  Given a nested frame inside the artifact posts a message whose type is "oa:anchor:new"
  When the host receives that message from a window that is not the artifact frame
  Then the host makes no network request
  And no reply is sent

Scenario: The host cannot be turned into an open proxy
  Given the artifact frame contains hostile script
  When that script posts a message asking the host to fetch "https://attacker.example/steal"
  Then the host ignores the supplied URL
  And any request it makes targets only "/api/artifacts/art_1/comments"
```

**Spec Source**: `../2026-07-16-anchored-comments-design/bdd-specs.md` (for reference)

## Interfaces

**Exposes** (from `src/wrap.ts`):
- Host bridge inline script (injected into `hostShell`) handling `oa:ready`/`oa:anchor:new`/`oa:anchor:open`; sending `oa:theme`/`oa:arm`/`oa:comments`.
- Frame bridge inline script (injected into `frameDocument`) posting `oa:ready`/`oa:anchor:new`/`oa:anchor:open`; applying `oa:theme`/`oa:arm`/`oa:comments`.
- (Recommended for testability) `bridgeRoute(type, id, commentId?)` pure helper.

**Consumes**: `escapeInlineScript`/`jsonForInlineScript` (`src/wrap.ts:21-27`); the serve-time `id`.

**Global Constraints respected**: `event.source` identity guard (both sides); fixed route table (no `msg.url`); host→frame only theme/arm/public-list; delete tokens never cross to the frame; scripts inlined under `script-src 'unsafe-inline'`.

## Files to Modify/Create

- Modify: `src/wrap.ts` (add `HOST_BRIDGE_SCRIPT` into `hostShell`, `FRAME_BRIDGE_SCRIPT` into `frameDocument`; optional `bridgeRoute` helper)

## Steps

### Step 1: Implement Logic (Green)
- Frame side: on load, `postMessage({type:"oa:ready"}, "*")` to `window.parent`; listen for `oa:theme`/`oa:arm`/`oa:comments` (guard `event.source === window.parent`).
- Host side: `addEventListener("message", …)` guarding `event.source === frame.contentWindow`; switch over the fixed allowlist; on `oa:anchor:new` open the compose popover (task 009 wires the actual create); reply/broadcast only to `frame.contentWindow` with `"*"`.
- Route table: `bridgeRoute(type, id, commentId)` returns fixed `/api/artifacts/${id}/comments[/${commentId}]` paths; unknown → null.
- **Verification**: `pnpm test -- tests/worker/viewer.test.ts` (and `bridge.test.ts`) PASSES.

### Step 2: Verify & Refactor
- `pnpm typecheck` + `pnpm check` clean.

## Verification Commands

```bash
pnpm test -- tests/worker/viewer.test.ts
pnpm typecheck
```

## Success Criteria

- Bridge enforces source identity + fixed allowlist; no path outside `/api/artifacts/${id}/...` is reachable.
