# Live edit (SaaS instances)

A hosted instance that bound a `LIVE_DO` Durable Object (coda0.com) supports
**live editing**: in the artifact viewer, open Live, pick an element, type a
prompt, and the authoring agent edits the artifact source locally and
saves a revisioned Draft. The user can recover or review that Draft without
changing published history; an explicit Checkpoint publishes it as a new,
immutable version. A WebSocket pushes the `done` ack to the browser. One shot
— no variant cycling.

## Starting live after a publish

On a live-capable instance, `create` responses include `liveSupported: true`,
and the CLI prints a watcher tip when you are logged in with an `sk_` token.
**Start the watcher by default right after the publish** — the user can open
the URL and start picking immediately:

```
node "$ARTIFACT_CLI" live <ID> --watch
```

**Your only job in a live session is to poll.** You never operate the viewer
page yourself — no browser automation on the artifact page, no clicking Live,
picking elements, or typing prompts. The user drives the viewer; your watcher
prints each `generate`/`edit` event for you to act on. The viewer's Live
button shows the watcher state (impeccable semantics): `Connected` accent pill
with no dot while your watcher is online (the watcher heartbeats every ~20s,
the viewer polls the status every ~15s, and the indicator clears within about
a minute of the watcher stopping); while a pending event is leased to the
agent, the accent dot pulses with the tooltip "Agent is working on an edit";
when the watcher drops, an amber dot pulses with "Agent disconnected - run the
watcher to connect", so the user can see an agent is online before they start
picking.

## Give this to your coding agent

Copy this block to your agent so it runs the live-edit loop on an artifact:

```
Live-edit artifact <ID> at coda0.com:
1. Ensure OPEN_ARTIFACTS_URL=https://coda0.com and logged in
   (`node "$ARTIFACT_CLI" whoami` must succeed).
2. Start the watcher (stays online for the whole session):
   node "$ARTIFACT_CLI" live <ID> --watch
   - Prints one JSON line per event on stdout (blocks until next event).
   - Auto-replies `ack` on each `generate`/`edit` so the host shows "agent is editing".
   - Your ONLY job is this watcher — do NOT operate the viewer page yourself
     (no browser automation, no clicking Live, picking elements, or typing
     prompts). The user drives the page.
3. The user opens https://coda0.com/a/<ID>, clicks Live (this arms the picker immediately). After an element is picked, the frame picker locks while its prompt input is open, so another element cannot replace the current draft. Pressing Enter (or Add) commits that element+prompt pair and re-arms the picker for the next item. They may also draw strokes or drop comment pins over the picked element. When all elements are described, they hit Submit.
4. Your watcher prints a generate event:
   {type:'generate', id, items:[{element:{tagName,id,classes,textContent,outerHTML,computedStyles,parentContext,boundingRect,rect}, prompt}], comments?, strokes?, screenshot?}
   - Each item carries its own `element` (full context) and `prompt` (the user's freeform description for that element).
   - `comments` (`[{x,y,text}]` in element-local CSS px) and `strokes`
     (`[{points:[[x,y],…]}]`) are the pins/strokes the user drew; `screenshot`
     is a data-URL PNG with them baked in when capture is possible.
   - Another `generate` can arrive while you are still editing a previous one —
     the watcher delivers new submissions immediately. Edit and reply `done`
     for each event id separately.
   - A `comment` event `{type:'comment', id, body, author, anchor, createdAt}`
     arrives whenever the user posts a comment while the live channel is up —
     no pick/submit needed. `anchor` locates the commented element (canvas
     point or text quote; see the comments feature). Reply with a normal
     `update` if you act on it; no `done` ack is expected for comments.
   - A comment is consumed from the transient live queue when `poll` returns
     it. The watcher never enters edit-ack waiting or exits on a comment; it
     prints like any other event and keeps polling. The comment remains in the
     artifact's persistent comment history.
   - An `edit` event `{type:'edit', id, pageUrl, items:[{id, element, ops}]}`
     arrives when the user applies their staged inline text edits (see "Copy
     edits" below): apply each op's `originalText` → `newText` in the Recipe
     source, `update <id> --live`, Checkpoint when ready, and reply
     `done --data '<json>'`.
5. Edit the artifact source to apply each item's requested change to its picked element (match by id → class → tag → outerHTML content). Do NOT inject variant wrappers — Live is one-shot edit-and-reload, not variant cycling.
6. Save the Live edit as a durable Draft revision (the published version and
   every historical hash remain unchanged):
   node "$ARTIFACT_CLI" update <ID> --live   (use the artifact's recipe, or pass the new recipe)
   - A stale editor receives a revision conflict; re-read/reapply instead of
     forcing over the winning Draft.
7. When the Draft is accepted, Checkpoint it explicitly:
   node "$ARTIFACT_CLI" live checkpoint <ID>
   - If the artifact was at v10, this atomically creates v11. It never rewrites
     v10. A stale base returns a conflict and preserves the Draft.
8. Ack: node "$ARTIFACT_CLI" live <ID> --reply <eid> done --version <new-version>
   - The browser receives `done` and reloads the newly published Checkpoint.
9. The watcher keeps polling for the next event (another generate, or `exit` when the browser closes the session). Stop it with Ctrl-C.
```

If you can't keep the watcher running, the one-shot
`node "$ARTIFACT_CLI" live <ID>` still works — but you must be polling before
the user hits Submit, because a `generate` event you miss stays in the
LiveObject's SQLite queue (survives hibernation) but won't wake you.

## Harness note

`live <id>` is one-shot: it blocks for one event (up to ~270s), prints one JSON
line on stdout, and exits. Claude Code may run it as a background task; Cursor
uses a background terminal with exit-notify; Codex runs it in the foreground.
Re-invoke to poll the next event. This is the same harness-agnostic contract
as `artifact login`.

`--reply <eid> done --version <v>` is fire-and-forget: it returns once the
LiveObject has broadcast `done` to the waiting browser.

## Ack-status polling

`--watch` paces one event at a time: after printing a `generate` and auto-acking
it, the watcher polls `GET /api/artifacts/<id>/live/status` until that event
leaves the pending queue (i.e. the agent's `done` reply has cleared it) before
polling for the next event. This closes the re-delivery race where a
lease-expired, unreplied event would otherwise be re-dispatched ahead of a newer
one. The reply POST is already synchronous, so this pacing is for the decoupled
watcher loop, not to confirm the reply itself.

**New submissions are not blocked by the wait.** When the user submits a newer
`generate` while the watcher is ack-waiting, the status poll returns `"new"`
and the watcher polls again immediately — the new event is delivered within a
poll interval, not after the agent finishes the previous edit. The newer poll
passes the already-delivered event ids as `?exclude=` so a lease-expired,
unreplied event is never re-delivered ahead of newer ones.

- `--ack-timeout=MS` - max wait per event's `done` (default 600000; `0` disables,
  restoring fire-and-forget polling).
- `--ack-poll=MS` - `/live/status` poll interval (default 1000; the status route
  is a remote Worker, not localhost, so 400ms-class intervals are too aggressive).
- When the watcher observes an `exit` (via pollOnce or `/live/status` during the
  ack-wait), it POSTs `/live/consume-exit` to drop queued exit rows, so a stale
  exit from a prior session can't poison a new `--watch` within the 1h GC window.
- On ack timeout the watcher warns on stderr and continues (resilient, not a hard
  fail). If the user exits the session during the wait, the next `/live/status`
  poll surfaces the `exit` event and the watcher stops promptly instead of
  blocking for the full timeout. Residual edge case: if the agent crashes and the
  timeout fires, the next poll may re-deliver the stale event - same as today's
  behavior; the common case (agent replies `done`) is fully fixed.

`live <id> --wait-ack <eid>` is the standalone form: block until event `<eid>`
leaves the pending queue or the ack timeout elapses. Useful as a defensive probe
after a reply, or as a building block for a custom poll loop.

## Element context (the `element` field)

The picker does NOT send a CSS selector or xpath — it sends a rich context
blob and lets the agent match it in source by id → class → tag:

- `tagName`, `id`, `classes[]` — match priority in source.
- `outerHTML` (≤10k) — locate by content if ids/classes are absent.
- `computedStyles` — font/color/radius/shadow (for styling-driven edits).
- `parentContext` — the parent tag+id, to disambiguate siblings.
- `boundingRect` — width/height for layout-driven edits.
- `rect` — `{x, y, width, height}` viewport coordinates inside the frame
  (the host uses this to float the action bar next to the element; the agent
  does not need it for source matching).

## Annotations

While live mode is open, the picked element carries a small drawing overlay:
the user can draw strokes or drop comment pins on it. On submit, the `generate`
event carries `comments` (`[{x,y,text}]` in element-local CSS px) and `strokes`
(`[{points:[[x,y],…]}]` raw point arrays) and a `screenshot` (a data-URL PNG
with the annotations baked in, when the browser can capture it — tainted
canvas or unsupported engines send none). In a multi-element batch the
coordinates are relative to the most recently picked element. Stroke shapes
are NOT classified by the browser — a closed loop, arrow, or cross is just a
point array; you infer the intent. A cross/slash on an element means delete; a
loop means "this thing"; an arrow means direction. No annotations → no
screenshot is sent.

## Copy edits (inline text editing)

The user can edit an element's text directly in the page instead of describing
a change: pick an element, click **Edit text**, type into the highlighted text
rows, Save. Edits are STAGED (not delivered immediately) — the dock shows an
"Apply copy edits (N)" pill; the user fixes several texts, then clicks Apply,
which commits ONE `edit` event:

```
{type:'edit', id, pageUrl, items:[{id, element, ops:[{ref, tag, elementId, classes, originalText, newText, leaf, nearbyEditableTexts}]}]}
```

`ops` fields:

- `originalText` — the TRUE source state of the row (kept across re-edits on
  the same row). **Match it EXACTLY as a source substring** — never from the
  served `outerHTML`/DOM text (whitespace, entities, and React escapes
  differ).
- `newText` — the user's replacement, plain text only (the browser rejects
  `<`, `{`, `}`, and backticks before sending).
- `ref` — `id || classes.join('.') || tagName` of the row (may repeat across
  rows; use it with `element` to disambiguate).
- `element` — the same context blob as `generate` (id → class → tag →
  outerHTML).
- `nearbyEditableTexts` — sibling rows' texts, to disambiguate repeated text.

Apply loop (one `edit` event per Apply):

1. Grep `originalText` across the Recipe sources (`.artifacts/recipes/**`,
   fragments). If no match, use the element context (id/classes/tag/outerHTML)
   to locate the containing element first, then the row by `ref`.
2. Replace `originalText` → `newText`, preserving `newText` exactly.
3. Verify `newText` landed: grep the touched files before republishing.
4. Save a Draft: `node "$ARTIFACT_CLI" update <ID> --live`
5. Checkpoint after validation: `node "$ARTIFACT_CLI" live checkpoint <ID>`
6. Reply with the canonical result JSON so the browser can show what landed:

```
node "$ARTIFACT_CLI" live <ID> --reply <eid> done --data '{"status":"done","appliedEntryIds":["stash_..."],"failed":[],"files":["..."],"notes":[]}'
```

- `appliedEntryIds` = the items' ids you applied; `failed` = `[{entryId,
  reason, candidates?}]` for ops you could not locate (e.g. the source
  changed since the user saved). The browser shows "N applied, M failed —
  re-edit them" and the stash clears on `done`. There is no repair loop:
  report failures honestly and let the user re-edit.
- An `error` reply keeps the stash so the user can retry or discard.

React artifacts: expression-rendered text (like `{title}`) never appears as a
literal substring. Quote the expression (`{"..."}`), update coupled lookup
keys, or report it as `failed` — the user re-edits. Framework file/line
`sourceHint` and op chunking are future work.

## Token & auth

`live` reuses the logged-in `sk_` (same precedence as other commands; see
`auth.md`). The poll/reply routes also require `authorizeView` on the
artifact, so private/org artifacts only accept live sessions from their
owner/org members — identical to the read gate.
