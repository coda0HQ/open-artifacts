Feature: Update an artifact
  As a coding agent
  I want to redeploy new content to an existing artifact URL
  So that viewers always see the latest version at the same link

  Background:
    Given a published artifact with id "abc" and a valid write token

  Scenario: Update with a valid write token
    When I PUT new content to /api/artifacts/abc with the write token
    Then the response status is 200
    And the artifact version increments to 2
    And GET /a/abc serves the new content immediately

  Scenario: Update without a write token
    When I PUT new content to /api/artifacts/abc without an Authorization header
    Then the response status is 401

  Scenario: Update with a wrong write token
    When I PUT new content to /api/artifacts/abc with token "wt_wrong"
    Then the response status is 403

  Scenario: Update a nonexistent artifact
    When I PUT new content to /api/artifacts/nope with any token
    Then the response status is 404

  Scenario: Update may change title and favicon
    When I PUT new content with title "New Title" to /api/artifacts/abc with the write token
    Then GET /api/artifacts/abc reports title "New Title"

  Scenario: Version label is recorded
    When I PUT new content with label "fixed-charts" to /api/artifacts/abc with the write token
    Then the version history for "abc" contains a version labeled "fixed-charts"

  Scenario: Concurrent write protection via baseVersion
    Given the artifact is at version 3
    When I PUT new content with baseVersion 2 with the write token
    Then the response status is 409
    And no new version is created

  Scenario: Force overrides a version conflict
    Given the artifact is at version 3
    When I PUT new content with baseVersion 2 and force true with the write token
    Then the response status is 200
    And the artifact version increments to 4

  Scenario: Delete an artifact
    When I DELETE /api/artifacts/abc with the write token
    Then the response status is 200
    And GET /a/abc returns 404
    And all stored versions are removed
