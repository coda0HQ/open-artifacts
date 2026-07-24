Feature: Live variant editing
  A deploy that binds a LIVE_DO Durable Object lets the viewer open a Live bar,
  pick an element, and cycle variants the authoring agent generates by editing
  the artifact source and republishing. A deploy without the binding keeps
  today's viewer.

  Background:
    Given an instance with an artifact published at /a/<id>

  Scenario: Deploy without LIVE_DO keeps today's viewer
    When the deploy has no LIVE_DO binding
    Then GET /api/artifacts/<id>/live returns 404
    And GET /api/artifacts/<id>/live/poll returns 404
    And POST /api/artifacts/<id>/live/reply returns 404
    And the /a/<id> host page renders no "Live" button
    And the /a/<id>/frame document carries the picker script (no-op until armed)

  Scenario: Deploy with LIVE_DO renders the Live button
    When the deploy binds a LIVE_DO Durable Object (SQLite, class LiveObject)
    Then the /a/<id> host page renders a "Live" toggle button
    And the host page embeds the live chrome (global bar + action bar)
    And a WebSocket upgrade to /api/artifacts/<id>/live is forwarded to the DO

  Scenario: The browser picks an element inside the sandboxed frame
    When the user clicks Live then Pick
    Then the host postMessages oa:live:pick:arm into the frame
    And the frame picker highlights the hovered element
    And on click the frame postMessages oa:element:picked with a context blob
    But the context is NOT a CSS selector — it is {tagName, id, classes, outerHTML, computedStyles, parentContext, boundingRect}

  Scenario: The agent generates N variants by editing source and republishing
    When the browser POSTs a generate event over the WebSocket
    Then the agent CLI polls GET /api/artifacts/<id>/live/poll and receives {type:'generate', element, action, count}
    And the agent edits the artifact source to wrap the picked element in a display:contents variant container with N variants
    And the agent runs `node artifact.mjs update <id>` to republish
    And the agent runs `node artifact.mjs live <id> --reply <eid> done --version <n>`
    Then the DO broadcasts {type:'done', id, version} to the subscribed browser
    And the frame's MutationObserver sees the [data-impeccable-variant] children and enters Cycling

  Scenario: Accept keeps the chosen variant, discard restores
    When the user cycles to variant N and clicks Accept
    Then the browser POSTs {type:'accept', id, variantId:N}
    And the agent updates the source to keep only variant N (drops the wrapper) and replies done
    Then the DO broadcasts {type:'accept'} and the host shows Confirmed

  Scenario: Annotation-aware generation
    When the user draws strokes or drops comment pins before Go
    Then the generate event carries comments [{x,y,text}] and strokes [{points:[[x,y],...]}] in element-local CSS px
    And a screenshot (data URL PNG with annotations baked in) is included
    But when no annotations are present, no screenshot is sent
