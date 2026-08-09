Feature: Live editing
  A deploy that binds a LIVE_DO Durable Object lets the viewer open a Live bar,
  pick one or more elements, and have the authoring agent edit the artifact
  source and republish - one shot per generate, no variant cycling and no
  accept/discard loop. A deploy without the binding keeps today's viewer.

  Background:
    Given an instance with an artifact published at /a/<id>

  Scenario: Deploy without LIVE_DO keeps today's viewer
    When the deploy has no LIVE_DO binding
    Then GET /api/artifacts/<id>/live returns 404
    And GET /api/artifacts/<id>/live/poll returns 404
    And POST /api/artifacts/<id>/live/reply returns 404
    And GET /api/artifacts/<id>/live/status returns 404
    And POST /api/artifacts/<id>/live/consume-exit returns 404
    And the /a/<id> host page renders no "Live" button
    And the /a/<id>/frame document carries the picker script (no-op until armed)

  Scenario: Deploy with LIVE_DO renders the Live button
    When the deploy binds a LIVE_DO Durable Object (SQLite, class LiveObject)
    Then the /a/<id> host page renders a "Live" toggle button (opens or closes live mode)
    And the host page embeds the live chrome (global bar + action bar)
    And a WebSocket upgrade to /api/artifacts/<id>/live is forwarded to the DO

  Scenario: The header Live button toggles live mode open and closed
    When the user clicks the Live button in the header
    Then the live dock opens and the host postMessages oa:live:pick:arm into the frame
    But clicking the Live button again closes the dock (it toggles, like the comments toggle)
    And the dock's Exit button also closes live mode

  Scenario: The Pick control is a display-only indicator
    When the user clicks the Live button in the header
    Then the Pick indicator in the dock shows pick mode is on (accent tint)
    But the Pick control is a display-only span, not a clickable button
    And the frame picker is armed while the dock is in PICKING
    And after an element is picked, the frame picker locks while its prompt is open
    And committing the prompt re-arms the frame picker for the next item

  Scenario: The header shows the watcher state with impeccable semantics
    When an agent runs `node artifact.mjs live <id> --watch`
    And the watcher heartbeats for the artifact
    Then the Live control in the header visibly says "Connected"
    And the Live toggle shows no status dot while connected
    But when the watcher stops, the Connected pill clears after the presence window
    And the Live toggle shows an amber pulsing status dot (6px, 1.4s animation)
    And the Live toggle's tooltip reads "Live agent not connected - run the watcher to connect"
    And the amber dot renders static under prefers-reduced-motion
    But when a pending event is leased to the agent, the Live toggle keeps its accent pulsing dot
    And the Live toggle's tooltip reads "Agent is working on an edit"

  Scenario: An offline Live toggle guides the user to start the watcher
    Given no agent is connected to the artifact
    When the user activates the Live toggle
    Then the Live dock opens a slim "Live agent not connected" banner with a "Show start prompt" disclosure
    And the startup prompt's copy button sits inside the expanded disclosure
    And the prompt tells the agent to run `node artifact.mjs live <id> --watch`
    And the banner auto-shows only once per session — a reopened offline dock keeps just the status row
    And while the banner is open, Escape closes the banner before it closes the dock
    And the Live editor still opens in PICKING mode so the user can select an element

  Scenario: The browser picks an element inside the sandboxed frame
    When the user clicks Live (pick is armed on entry)
    Then the frame picker highlights the hovered element
    And on click the frame postMessages oa:element:picked with a context blob
    And the host locks the frame picker while the prompt input is open
    And subsequent clicks cannot pick another element until the prompt is committed
    But the context is NOT a CSS selector - it is {tagName, id, classes, outerHTML, computedStyles, parentContext, boundingRect}

  Scenario: The agent edits source once and republishes
    When the browser sends a generate event over the WebSocket with items [{element, prompt, rect}]
    Then the agent CLI polls GET /api/artifacts/<id>/live/poll and receives {type:'generate', items}
    And the agent edits the artifact source and runs `node artifact.mjs update <id> --live` to replace the current version
    And the agent runs `node artifact.mjs live <id> --reply <eid> done --version <v>`
    Then the DO broadcasts {type:'done', id, version} to the subscribed browser
    And the host reloads the frame and shows CONFIRMED "Applied"
    And then re-arms pick and returns to PICKING for the next item

  Scenario: A Live edit checkpoints an immutable new version
    Given the artifact is currently served at version 10
    When the agent applies the Live-edited Recipe with the Live update command
    Then the artifact content is committed as version 11
    And the content hash behind version 10 remains unchanged
    And a later ordinary update creates version 12

  Scenario: The viewer is told when a new version is published mid-session
    Given a live channel is up (the owner's page holds a WebSocket)
    When the agent publishes a new version via PUT /api/artifacts/<id>, the Live update command, or a channel republish
    Then the DO broadcasts {type:'version', id, version} to the subscribed browser
    But the version broadcast is never enqueued - it never appears in /live/poll or /live/status pendingEvents
    And a deploy without the LIVE_DO binding publishes normally with no broadcast
    And the browser WebSocket channel only enqueues user actions (generate, comment, exit) - reply types and the version signal cannot be injected into the agent poll queue
    And POST /live/reply accepts only agent-reply types (ack, done, error) - any other type returns 400 instead of broadcasting a fake signal

  Scenario: A staying viewer auto-refreshes when a new version lands
    Given the user is staying on the artifact page with a live channel up
    When the host receives a version broadcast
    Then the host reloads the frame in place and re-arms pick once the frame reports ready
    But a version-pinned view (?v=) never auto-reloads
    And in the interactive flow the done reply owns the reload (exactly one reload per edit) and the version broadcast arms only a fallback
    And when a publish carries no live reply (no done lands within the window), the version fallback reloads the staying viewer
    And while the user has a compose prompt open or inline text editing active, the host toasts instead of reloading

  Scenario: Exiting during the edit-confirmed window does not strand the user
    When the agent finishes an edit and the host shows CONFIRMED "Applied"
    And the user exits live mode before the auto-re-arm timer fires
    Then the frame still reloads to show the new version
    But the host does not arm pick on a closed dock
    And reopening live mode arms pick cleanly (no stale PICKING state)

  Scenario: The Live and Handoff docks are mutually exclusive
    When the deploy binds a LIVE_DO Durable Object and sets OPEN_ARTIFACTS_HANDOFF=1
    And the owner sees both the Live and Handoff buttons
    Then opening Live closes the Handoff dock
    And opening Handoff tears down the Live editor
    But Live refuses to open while a handoff is recording or playing
    So both docks are never expanded at once

  Scenario: The live status endpoint reports pending events
    When the deploy binds a LIVE_DO Durable Object (SQLite, class LiveObject)
    And the browser sends a generate event over the WebSocket with items [{element, prompt, rect}]
    Then GET /api/artifacts/<id>/live/status returns {pendingEvents} containing that generate event id
    But after the agent replies done via POST /api/artifacts/<id>/live/reply
    Then GET /api/artifacts/<id>/live/status no longer contains that event id
    And the status route uses the artifact view gate so a hosted sk_ watcher can poll

  Scenario: The watch loop waits for an event ack before polling the next
    When the agent runs `node artifact.mjs live <id> --watch`
    And a generate event arrives
    Then the watch auto-replies ack and prints the event on stdout
    And the watch polls GET /api/artifacts/<id>/live/status at a bounded interval until the event leaves pendingEvents before polling the next event
    But when a newer generate event arrives during the wait, the watch delivers it immediately
    And the newer poll excludes in-flight event ids so a lease-expired event is never re-delivered
    And `--ack-timeout=0` disables the wait and restores fire-and-forget polling
    And a standalone `node artifact.mjs live <id> --wait-ack <eid>` blocks until that event is cleared or the ack timeout elapses

  Scenario: An observed exit is consumed so it does not poison a new session
    When the browser closes the live session (enqueues an exit event)
    And the agent's watcher observes the exit via pollOnce or /live/status during an ack-wait
    Then the watcher POSTs /api/artifacts/<id>/live/consume-exit to drop the exit row
    And a new `node artifact.mjs live <id> --watch` started within the GC window does not break on the stale exit

  Scenario: The watcher heartbeats so the viewer shows it is online
    When the deploy binds a LIVE_DO Durable Object (SQLite, class LiveObject)
    And the agent CLI runs `node artifact.mjs live <id> --watch`
    Then the watcher POSTs /api/artifacts/<id>/live/heartbeat on a fixed interval while watching
    And GET /api/artifacts/<id>/live/status reports agentActive true with a lastAgentSeen timestamp
    But before any heartbeat, GET /api/artifacts/<id>/live/status reports agentActive false
    And the heartbeat route uses the artifact view gate so a hosted sk_ watcher can stay online
    And the heartbeat route 404s when the deploy has no LIVE_DO binding

  Scenario: Create advertises live support and the CLI prompts to start the watcher
    When the deploy binds a LIVE_DO Durable Object
    Then POST /api/artifacts returns liveSupported true
    But a deploy without the binding returns liveSupported false
    And a logged-in (sk_) create prints a tip to start `live <id> --watch` and how the user operates the Live bar
    But a create without an sk_ token prints no such tip

  Scenario: The generate event carries the user's annotations
    When the user opens Live in the viewer
    Then the host arms the frame picker and enables annotations (oa:live:annot:enable)
    And on submit the host collects the frame's annotations (oa:live:annot:collect)
    And the frame replies oa:live:annot:data with comments, strokes, and a screenshot when capturable
    And the host sends generate with those comments/strokes/screenshot, or omits them when empty

  Scenario: A posted comment streams to the watcher immediately
    When a live channel is up (the owner's page holds a WebSocket)
    And the user posts a comment
    Then the host pushes {type:'comment', id, body, author, anchor, createdAt} over the WebSocket
    And the watcher's poll delivers the comment event promptly (even during an ack-wait)
    And delivering the comment removes it from the pending event queue
    But the watcher does not enter edit-ack waiting or exit on a comment — it just prints and keeps polling

  Scenario: A live poll failure tells the operator why
    When the agent CLI polls /api/artifacts/<id>/live/poll and the instance responds 401, 403, or 404
    Then the one-shot `live <id>` exits with a hint naming the artifact/token problem
    And `--watch` prints the hint once and keeps retrying

  Scenario: An empty prompt cannot be committed
    When the user picks an element and the compose row opens
    Then the Add button is disabled until the prompt input has text
    And pressing Enter on an empty prompt keeps the draft open and toasts "Type a change first"
    And no chip is created and Submit stays disabled

  Scenario: The user can cancel a pick
    When the user picks an element and the compose row opens
    Then the compose row offers a "Cancel this pick" button
    And clicking it clears the draft, disarms the frame picker, and re-arms it
    And the dock returns to PICKING without a chip

  Scenario: Apply and Discard confirm in place
    Given staged edits exist and the Apply pill shows "Apply copy edits (N)"
    When the user clicks Apply
    Then the pill morphs to "Confirm apply?" for a few seconds
    And a second click within the window commits the edit event
    But after the window lapses without a second click, the pill reverts to "Apply copy edits (N)"
    And clicking Discard arms a danger tint that a second click confirms
    And no native browser confirm dialog is used

  Scenario: Applying without a watcher warns and times out fast
    Given staged edits exist and no agent is connected to the artifact
    When the user confirms Apply
    Then the status row warns "No agent connected — the edit will queue until a watcher connects"
    And the ack wait times out after about 20 seconds instead of the 2-minute default
    And the stall hint still names the CLI watcher as the fix

  Scenario: A queued edit can be cancelled
    Given staged edits exist and no agent is connected
    When the user confirms Apply
    Then the Apply pill morphs to "Queued (1) — click to cancel"
    And the queued edit event is listed as pending in /live/status
    And clicking the queued pill DELETEs /api/artifacts/<id>/live/events/<eid>
    And the pill reverts to "Apply copy edits (N)" with the stash intact
    But cancelling an event the agent already picked up returns 409

  Scenario: The stall hint for a queued edit names the queue
    When an edit was committed with no agent connected
    Then after the short ack timeout the status row says the edit is queued and will apply when a watcher connects

  Scenario: A touch tap picks an element
    When the user taps a pickable element on a touch device
    Then the frame selects it on pointerdown without a mousemove hover
    And the dock and the floating action bar respect env(safe-area-inset-bottom)

  Scenario: Send all appears on the floating bar
    When the user has committed items and picks another element
    Then the compose bar offers "Send all (N)" next to the prompt row
    And clicking it submits the batch exactly like the dock Submit

  Scenario: Exit with a batch confirms before discarding
    When items exist in the batch and the user clicks Exit
    Then the Exit button arms with "Discard N changes?" for a few seconds
    And a second click discards the batch and closes the dock
    But with no items, Exit closes immediately

  Scenario: The user picks an element and chooses Edit text
    When the user clicks Live (pick is armed on entry) and picks an element
    Then the compose row offers an "Edit text" chip next to the freeform prompt
    And clicking the chip postMessages oa:live:edit:arm into the frame
    And the frame makes the picked element's pure-text leaf rows contenteditable with a data-original-text attribute
    And the editable rows carry a dashed outline affordance with a solid focus ring (frame-injected style)
    But pasting rich content into a row is stripped to plain text
    And mixed-content text nodes are wrapped in marker spans first
    And pressing Escape restores every edited row's original text
    And the dock status row names the missing agent while live is open but no watcher is connected

  Scenario: Saving an edit stages ops server-side
    When the user edits text rows and clicks Save
    Then the frame validates each row (non-empty newText, no < { } or backtick) and rejects otherwise with oa:live:edit:rejected
    And the frame postMessages oa:live:edit:data with {element, ops:[{ref, originalText, newText, ...}]}
    And the host POSTs /api/artifacts/<id>/live/edit-stash with the ops
    And re-saving the same (pageUrl, ref) replaces newText but keeps the original originalText
    But saving an edit requires write access — a tokenless viewer POSTs /live/edit-stash and gets 401 (missing bearer write token)
    And the dock shows an "Apply copy edits (N)" button counting the staged ops

  Scenario: Apply copy edits commits one edit event
    When the user clicks Apply copy edits
    Then the host POSTs /api/artifacts/<id>/live/edit-commit and the DO enqueues {type:'edit', items}
    And the edit event is delivered to the agent's poll ahead of any pending generate
    And the watch loop auto-replies ack and enters edit-ack waiting like a generate
    And the agent edits the artifact source and runs `node artifact.mjs live <id> --reply <eid> done --data '{"status":"done","appliedEntryIds":[...],"failed":[],"files":[...],"notes":[]}'`
    Then the DO clears that page's staged edits and broadcasts {type:'done', id, status, appliedEntryIds, failed}
    And the host shows "Applied" with the applied/failed summary, empties the Apply pill, and reloads the frame

  Scenario: Discarding the stash clears staged ops
    When the user clicks the discard button on the Apply pill
    Then the host DELETE /api/artifacts/<id>/live/edit-stash and the dock hides the Apply pill
    And a later Apply copy edits with an empty stash returns 409

  Scenario: Staged edits survive a reload
    Given staged edits exist for the artifact
    When the user reloads the page or reopens live mode
    Then the host GET /api/artifacts/<id>/live/edit-stash restores the "Apply copy edits (N)" pill

  Scenario: A pending edit is delivered ahead of a generate
    When a generate event and a committed edit are both pending in the LiveObject queue
    Then the agent's poll returns the edit event first (priority: exit > edit > generate > other)
    And the edit event id starts with `ev_`

  Scenario: The frame picker registers a single message listener
    Then the picker script contains exactly one addEventListener('message' handler
    And its annotation reply handler calls sendAnnots with the request token (sendAnnots(m.req))
