Feature: View an artifact
  As a viewer with a shared link
  I want the artifact to render as a complete, safe web page
  So that I can read it without needing any account

  Scenario: Viewer wraps content in a full HTML skeleton
    Given a published artifact whose stored content is a body fragment
    When I GET /a/:id
    Then the response is a complete HTML document with doctype, head, and body
    And the head contains the artifact title
    And the head contains an emoji favicon as an SVG data URI
    And a minimal CSS reset is inlined

  Scenario: Strict CSP blocks external requests
    When I GET /a/:id
    Then the Content-Security-Policy header forbids all external hosts
    And inline styles and scripts are allowed
    And images are allowed only from data: URIs

  Scenario: Theme awareness
    When I GET /a/:id
    Then the page responds to prefers-color-scheme
    And a data-theme attribute on the root element overrides the OS scheme

  Scenario: Unknown artifact id
    When I GET /a/doesnotexist
    Then the response status is 404

  Scenario: View a specific version
    Given an artifact with 3 versions
    When I GET /a/:id?v=2
    Then the content of version 2 is served

  Scenario: Raw content is readable for agents
    When I GET /api/artifacts/:id/raw
    Then the stored content is returned unwrapped
