# BDD Specs — Anchored Comments

Gherkin scenarios for the anchored-comments feature. Each scenario is tagged with the
requirement IDs (`REQ-NNN`) from `_index.md` that it covers. Implementation extends
`tests/features/comments.feature`; new scenarios land in
`tests/features/anchored-comments.feature`.

The artifact renders inside a sandboxed **artifact frame** (opaque origin,
`connect-src 'none'`). All comment reads and writes are performed by the outer **host page**,
the only party that touches the network; the frame and host exchange a fixed set of
`postMessage` types.

```gherkin
Feature: Anchored comments on artifacts
  As a viewer of a shared artifact
  I want to attach a comment to a specific spot or passage
  So that feedback is tied to what it refers to and reaches every future viewer

  Background:
    Given an artifact "art_1" published at version 3
    And the viewer has opened the host page at "/a/art_1"
    And the artifact body is displayed inside the sandboxed frame at "/a/art_1/frame"

  # ---------- Host / frame split (REQ-012) ----------

  @REQ-012 @REQ-006
  Scenario: The host page and the artifact frame have different security envelopes
    Given the host page was served for "/a/art_1"
    And the artifact frame was served for "/a/art_1/frame"
    Then the host page response has "connect-src 'self'" and "frame-src 'self'" and no sandbox directive
    And the frame response has "sandbox allow-scripts" and "connect-src 'none'"
    And the frame's document origin is opaque

  @REQ-012 @REQ-017
  Scenario: The frame sub-route refuses to serve an encrypted artifact as plaintext
    Given an encrypted artifact "art_enc" exists
    When a request is made for "/a/art_enc/frame"
    Then the response status is 404
    And no plaintext artifact body is returned

  @REQ-012 @REQ-003
  Scenario: The host page still carries crawler metadata
    Given a crawler requests "/a/art_1"
    Then the response contains the artifact title and the "og:image" pointing at "/og/art_1"
    And the "og:url" points at "/a/art_1" and never at "/a/art_1/frame"

  # ---------- Authoring: canvas point mode (REQ-001, REQ-002, REQ-009) ----------

  @REQ-001 @REQ-002 @REQ-009 @REQ-013
  Scenario: Post a point-anchored comment on a canvas artifact
    Given "art_1" is a canvas artifact whose plane transform is "matrix(2, 0, 0, 2, 100, 40)"
    And the viewer has armed the comment tool
    When the viewer clicks the canvas at client point x 300 y 240
    And types "this shape is off-center" and submits
    Then a comment is stored for "art_1" with a point anchor at world x 100 y 100
    And the point anchor records "anchorVersion" 3
    And a pin marker is rendered at that world point inside the frame
    And the host page performed the create request, not the frame

  @REQ-009 @REQ-014
  Scenario: A pin stays a constant on-screen size while the canvas zooms
    Given "art_1" has a point-anchored comment at world x 100 y 100
    When the plane zooms from scale 1 to scale 4
    Then the pin marker remains centered on world x 100 y 100
    And the pin marker's on-screen size does not change

  # ---------- Authoring: normal-page text mode (REQ-001, REQ-002, REQ-009) ----------

  @REQ-001 @REQ-002 @REQ-009
  Scenario: Post a text-range comment on a normal page
    Given "art_1" is a normal HTML artifact containing the sentence "quarterly revenue grew 12% in Q3"
    And the viewer has armed the comment tool
    When the viewer selects the text "quarterly revenue grew 12%"
    And types "source for this?" and submits
    Then a comment is stored for "art_1" with a text anchor
    And the text anchor records the quote "quarterly revenue grew 12%"
    And the text anchor records a prefix of at most 32 characters and a suffix of at most 32 characters
    And a highlight marker covers "quarterly revenue grew 12%" inside the frame

  @REQ-009 @REQ-013
  Scenario: A duplicated quote is disambiguated by surrounding context
    Given "art_1" is a normal HTML artifact containing the word "Total" at character offset 40 and at character offset 900
    And a text comment quotes "Total" with the prefix and suffix taken from around character offset 900
    When the frame re-anchors the comment
    Then the highlight marker is placed at the occurrence at character offset 900

  # ---------- Identity (REQ-005) ----------

  @REQ-005
  Scenario: The author name comes from the locally saved display name
    Given the viewer has saved the display name "Dana" in host-page local storage
    When the viewer posts a comment reading "looks good"
    Then the stored comment's author is "Dana"
    And the display name was read from host-page local storage, not from the frame

  # ---------- Persistence (REQ-003) ----------

  @REQ-003
  Scenario: A persisted anchored comment reappears for a future viewer
    Given "Dana" posted a point-anchored comment on "art_1" at world x 100 y 100
    When a second viewer opens "/a/art_1" one hour later
    Then the second viewer sees Dana's comment in the drawer
    And a pin marker is rendered at world x 100 y 100 with no runtime fetch for the initial render

  # ---------- Marker opens the reused drawer (REQ-004) ----------

  @REQ-004 @REQ-013
  Scenario: Clicking a marker opens that anchor's thread in the drawer
    Given "art_1" has a point-anchored comment "c_3" reading "fix this label" at world x 100 y 100
    And the drawer is closed
    When the viewer clicks the pin marker for "c_3"
    Then the frame sends an "oa:anchor:open" message identifying "c_3" to the host
    And the host opens the Phase-1 drawer scrolled to the thread for "c_3"

  # ---------- Bridge boundary (REQ-006, REQ-013) ----------

  @REQ-006 @REQ-013
  Scenario: The host relays comment reads and writes for the air-gapped frame
    Given the artifact frame has "connect-src 'none'" and an opaque origin
    When the frame needs to persist a new comment
    Then the frame sends an "oa:anchor:new" message to the host over postMessage
    And the host page makes the create request and posts the refreshed list back to that frame window only

  @REQ-013
  Scenario: The host ignores a postMessage from an unexpected window
    Given a nested frame inside the artifact posts a message whose type is "oa:anchor:new"
    When the host receives that message from a window that is not the artifact frame
    Then the host makes no network request
    And no reply is sent

  @REQ-013 @REQ-006
  Scenario: The host cannot be turned into an open proxy
    Given the artifact frame contains hostile script
    When that script posts a message asking the host to fetch "https://attacker.example/steal"
    Then the host ignores the supplied URL
    And any request the host makes targets only "/api/artifacts/art_1/comments"

  # ---------- Orphaned anchors and version drift (REQ-010, REQ-011) ----------

  @REQ-010 @REQ-011
  Scenario: A text anchor that no longer matches becomes orphaned but stays listed
    Given "Dana" posted a text comment on "art_1" quoting "the old pricing table" against version 2
    And "art_1" was republished at version 3 without the text "the old pricing table"
    When the viewer opens "/a/art_1" at version 3
    Then Dana's comment is listed in the drawer flagged as orphaned
    And no highlight marker is drawn for it
    And the comment card shows the tag "· v2"

  @REQ-011
  Scenario: A comment made against a newer version than the one being viewed is not anchored
    Given "art_1" has a point-anchored comment recorded against version 3
    When the viewer opens "/a/art_1" at version 2
    Then the comment is listed in the drawer without a pin marker
    And the comment card shows the tag "· v3"

  # ---------- Deletion and moderation (REQ-007, REQ-008) ----------

  @REQ-007
  Scenario: Delete your own comment with its delete token
    Given the viewer posted a comment on "art_1" and holds the delete token "dt_abc" for it
    When the viewer deletes that comment with the delete token "dt_abc"
    Then the comment is removed from "art_1"
    And it no longer appears for a future viewer

  @REQ-007
  Scenario: A delete with the wrong token is rejected
    Given "Dana" posted a comment "c_9" on "art_1"
    And a second viewer holds the delete token "dt_wrong" which does not match "c_9"
    When the second viewer attempts to delete "c_9" with the delete token "dt_wrong"
    Then the request is rejected with status 403
    And the comment "c_9" remains on "art_1"

  @REQ-008
  Scenario: The artifact owner moderates any comment with the write token
    Given a viewer posted a comment "c_10" on "art_1"
    And the owner holds the artifact write token "wt_owner"
    When the owner deletes "c_10" with the write token "wt_owner"
    Then the comment "c_10" is removed from "art_1"

  @REQ-007
  Scenario: Deleting a comment that belongs to a different artifact is not found
    Given a comment "c_x" exists on artifact "art_2"
    When a request is made to delete "c_x" under "/a/art_1"
    Then the request is rejected with status 404

  # ---------- Validation and escaping (REQ-016) ----------

  @REQ-016
  Scenario: A point anchor with a non-finite coordinate is rejected
    Given a create payload with a point anchor whose x is the string "Infinity"
    When the payload is posted to "/api/artifacts/art_1/comments"
    Then the request is rejected with status 400
    And no comment is stored

  @REQ-016
  Scenario: A text anchor whose quote exceeds 1000 characters is rejected
    Given a create payload with a text anchor whose quote is 1001 characters long
    When the payload is posted to "/api/artifacts/art_1/comments"
    Then the request is rejected with status 400
    And no comment is stored

  @REQ-016
  Scenario: An anchor JSON larger than 2 KiB is rejected
    Given a create payload whose serialized anchor is 2049 bytes
    When the payload is posted to "/api/artifacts/art_1/comments"
    Then the request is rejected with status 400

  @REQ-016 @REQ-002
  Scenario: A comment body larger than 8 KiB is rejected
    Given a create payload whose body is 8193 bytes
    When the payload is posted to "/api/artifacts/art_1/comments"
    Then the request is rejected for exceeding the size limit
    And no comment is stored

  @REQ-016 @REQ-006
  Scenario: Attacker markup in the author name and body renders as text
    Given a comment on "art_1" whose author is the text "<img src=x onerror=alert(1)>"
    And whose body is the text "</script><script>alert(2)</script>"
    When the comment is rendered in the drawer
    Then the markup is shown as literal text and no script executes

  # ---------- Encrypted scope (REQ-017) ----------

  @REQ-017
  Scenario: An encrypted artifact accepts an unanchored comment but rejects a text anchor
    Given an encrypted artifact "art_enc" exists
    When an unanchored comment reading "nice work" is posted to "/api/artifacts/art_enc/comments"
    Then the comment is stored for "art_enc"
    When a text-anchored comment quoting "secret revenue $5M" is posted to "/api/artifacts/art_enc/comments"
    Then the request is rejected with status 400
    And no plaintext quote is stored for "art_enc"

  # ---------- Back-compat (REQ-015) ----------

  @REQ-015
  Scenario: A legacy Phase-1 comment still renders and is owner-removable only
    Given "art_1" has a Phase-1 comment "c_legacy" whose anchor is NULL and whose delete-token hash is NULL
    When the viewer opens "/a/art_1"
    Then "c_legacy" appears in the drawer with no pin and no highlight
    And "c_legacy" cannot be deleted with any comment delete token
    But the owner can remove "c_legacy" with the write token "wt_owner"

  # ---------- Design register (REQ-014) ----------

  @REQ-014
  Scenario: Markers, popover, and drawer read in both themes and are keyboard-operable
    Given the host page is stamped with data-theme "light" and then with data-theme "dark"
    Then every pin, highlight, compose popover, and drawer control uses tokens for color in both themes
    And the compose input and the submit and delete controls show a visible focus ring on keyboard focus
    And a comment can be dropped, typed, submitted, and dismissed using the keyboard alone
```
