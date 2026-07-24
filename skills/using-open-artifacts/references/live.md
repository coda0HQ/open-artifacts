# Live variant editing (SaaS instances)

A hosted instance that bound a `LIVE_DO` Durable Object (coda0.com) supports
**live variant editing**: in the artifact viewer, open the Live bar, pick an
element, choose an action, and the authoring agent generates N variants you
cycle and accept/discard in seconds. The agent edits the artifact source
locally and republishes; a WebSocket pushes the result to the browser.

## Give this to your coding agent

Copy this block to your agent so it runs the live-edit loop on an artifact:

```
Live-edit artifact <ID> at coda0.com:
1. Ensure OPEN_ARTIFACTS_URL=https://coda0.com and logged in (node artifact.mjs whoami must succeed).
2. The user opens https://coda0.com/a/<ID>, clicks Live, picks an element, picks an action, and hits Go.
3. You poll one event: node artifact.mjs live <ID>
   - stdout is one JSON line: {type:'generate', id, action, count, element:{tagName,id,classes,textContent,outerHTML,computedStyles,parentContext,boundingRect}, comments?, strokes?, screenshot?}
4. Edit the artifact source: wrap the picked element in a display:contents variant container with N variants:
   <!-- oa-variants-start -->
   <div data-impeccable-variants="ID" data-impeccable-variant-count="N" style="display:contents">
     <div data-impeccable-variant="0">…original…</div>
     <div data-impeccable-variant="1">…variant 1…</div>
     <div data-impeccable-variant="2">…variant 2…</div>
   </div>
   <!-- oa-variants-end -->
5. Publish: node artifact.mjs update <ID>   (use the artifact's recipe, or pass the new recipe)
6. Ack: node artifact.mjs live <ID> --reply <eid> done --version <new-version>
   - The browser's frame MutationObserver sees the wrapper and enters Cycling.
7. Loop on accept/discard events (same `live <ID>` poll):
   - accept {type:'accept', id, variantId}: update the source to keep ONLY the chosen variant (drop the wrapper), reply done.
   - discard {type:'discard', id}: update to restore the original (no wrapper), reply done.
   - The reply is: node artifact.mjs live <ID> --reply <eid> done --version <version-after-update>
```

## Harness note

`live <id>` is one-shot: it blocks for one event (up to ~270s), prints one JSON
line on stdout, and exits. Claude Code may run it as a background task; Cursor
uses a background terminal with exit-notify; Codex runs it in the foreground.
Re-invoke to poll the next event. This is the same harness-agnostic contract
as `artifact login`.

## Element context (the `element` field)

The picker does NOT send a CSS selector or xpath — it sends a rich context
blob and lets the agent match it in source by id → class → tag:

- `tagName`, `id`, `classes[]` — match priority in source.
- `outerHTML` (≤10k) — locate by content if ids/classes are absent.
- `computedStyles` — font/color/radius/shadow (for styling-driven variants).
- `parentContext` — the parent tag+id, to disambiguate siblings.
- `boundingRect` — width/height for layout-driven variants.

## Annotations

If the user drew strokes or dropped comment pins before Go, the `generate`
event also carries `comments` (`[{x,y,text}]` in element-local CSS px) and
`strokes` (`[{points:[[x,y],…]}]` raw point arrays) and a `screenshot` (a data
URL PNG with the annotations baked in). Stroke shapes are NOT classified by
the browser — a closed loop, arrow, or cross is just a point array; you infer
the intent. A cross/slash on an element means delete; a loop means "this
thing"; an arrow means direction. No annotations → no screenshot is sent.

## Token & auth

`live` reuses the logged-in `sk_` (same precedence as other commands; see
`auth.md`). The poll/reply routes also require `authorizeView` on the
artifact, so private/org artifacts only accept live sessions from their
owner/org members — identical to the read gate.
