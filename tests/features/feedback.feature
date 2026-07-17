Feature: Project-change feedback channel (type 2)
  As a viewer of a published artifact
  I want to send a "change the source project" note from the host chrome
  So that the owning agent can poll it, edit the project, and decide whether to regenerate

  Scenario: Viewer submits project-change feedback from the host chrome
    Given an artifact exists at id "abc123"
    When the host chrome POSTs feedback { "projectRef": "src/dashboard", "body": "Add a dark chart variant" } to /api/artifacts/abc123/feedback
    Then the response status is 201
    And the response echoes a feedback id
    And the feedback is stored as an independent record, not a new artifact version

  Scenario: Feedback is accepted on an open instance without a write token
    Given no CREATE_TOKEN is set and no bearer token is presented
    When the host chrome POSTs feedback to /api/artifacts/abc123/feedback
    Then the response status is 201

  Scenario: A gated instance rejects anonymous feedback
    Given CREATE_TOKEN is set and no valid write token is presented
    When the host chrome POSTs feedback to /api/artifacts/abc123/feedback
    Then the response status is 401

  Scenario: A write-token holder's feedback is accepted on a gated instance
    Given CREATE_TOKEN is set and a wt_ bearer token for artifact "abc123" is presented
    When the host chrome POSTs feedback to /api/artifacts/abc123/feedback
    Then the response status is 201

  Scenario: The agent polls pending feedback for an artifact
    Given two pending feedback records exist for artifact "abc123"
    When the owner GETs /api/artifacts/abc123/feedback?status=pending with the write token
    Then the response status is 200
    And the response lists both pending records ordered oldest first

  Scenario: Polling pending feedback is owner-only
    Given pending feedback exists for artifact "abc123"
    When a request GETs /api/artifacts/abc123/feedback?status=pending without a token
    Then the response status is 401

  Scenario: The agent advances feedback status through the lifecycle
    Given feedback record "fb1" for artifact "abc123" is in status "pending"
    When the owner POSTs /api/artifacts/abc123/feedback/fb1/ack advancing to "in_review"
    Then the response status is 200
    And the record status is "in_review"
    When the owner POSTs /api/artifacts/abc123/feedback/fb1/ack advancing to "in_progress"
    Then the record status is "in_progress"
    When the owner POSTs /api/artifacts/abc123/feedback/fb1/ack advancing to "done"
    Then the record status is "done"

  Scenario: The agent closes feedback without regenerating at the lifecycle end
    Given feedback record "fb1" for artifact "abc123" is in status "in_progress"
    When the owner advances it to "done"
    Then the record no longer appears in pending polls
    And the artifact version is unchanged (no regen was triggered)

  Scenario: Source-project metadata is inlined at serve time
    Given an artifact created from project path "src/dashboard"
    When a viewer GETs /a/abc123
    Then the served HTML inlines the projectRef so the host chrome can attach it

  # The panel POSTs. It is only reachable from a document whose CSP permits a
  # same-origin fetch — the host page (connect-src 'self'), never the artifact
  # frame (connect-src 'none', opaque origin). Rendering it in the frame would
  # ship a button that silently fails.
  Scenario: The feedback panel is served where it can actually POST
    Given an artifact exists at id "abc123"
    When a viewer GETs /a/abc123
    Then the host page's CSP allows a same-origin connect
    And the host page carries the feedback toggle and panel

  Scenario: The air-gapped artifact frame carries no feedback control
    Given an artifact exists at id "abc123"
    When a viewer GETs /a/abc123/frame
    Then the frame's CSP forbids every connect
    And the frame carries neither the feedback toggle nor the panel
