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

  Scenario: Strict CSP isolates the artifact frame from external requests
    When I GET /a/:id/frame
    Then the Content-Security-Policy header forbids all external hosts
    And inline styles and scripts are allowed
    And images are allowed only from data: or blob: URIs

  Scenario: Theme awareness
    When I GET /a/:id
    Then the page responds to prefers-color-scheme
    And a data-theme attribute on the root element overrides the OS scheme

  Scenario: The artifact presents as a sheet on a quiet backdrop
    Given a published HTML artifact
    When I GET /a/:id/frame
    Then the frame root paints a themed backdrop tone derived from the surface token
    And the body presents the artifact as a rounded, hairline-bordered sheet inset from the frame viewport
    And the window stays the scroll container so recorded handoff scroll keeps working

  Scenario: Canvas artifacts keep the full-bleed plane
    Given a published canvas artifact whose plane carries a transform
    When I GET /a/:id/frame
    Then the frame detects the canvas mode before first paint
    And the flat opt-out is decided structurally, not by resolved style
    And the sheet presentation carries a style-only opt-out for the same class pair
    And the sheet inset is removed so the plane owns the full frame viewport
    And the frame exposes no header height, so the canvas and its dot lattice cover every edge

  Scenario: A full-bleed canvas frame keeps its boundary ring
    Given a published canvas artifact whose frame body sits flush with a full-bleed child
    When I GET /a/:id/frame
    Then the frame body boundary ring paints on an overlay above frame content
    So the top and bottom edges of the frame stay visible at every zoom

  Scenario: Authored sticky headers pin inside the sheet edge
    Given a published HTML artifact whose own CSS pins a sticky header at the viewport top
    When I GET /a/:id/frame
    Then the frame re-pins the sticky header below the sheet's top inset

  Scenario: The host page itself stays full-bleed behind the frame
    Given a published HTML artifact
    When I GET /a/:id
    Then the host page carries no sheet presentation of its own
    And the artifact frame keeps its fixed full-bleed positioning below the header

  Scenario: Service header chrome is isolated from author CSS
    Given a published HTML artifact whose own CSS styles the ".oa-title" class
    When I GET /a/:id
    Then the resident service header names its title with a reserved class
    So the generator only supplies data and cannot restyle the header

  Scenario: Service header remains usable on a narrow viewport
    Given a published artifact with a long title and secondary controls
    When I view the artifact on a narrow viewport
    Then the favicon and truncated title remain visible
    And comments and theme remain directly available
    And the remaining artifact controls are available from a More panel
    And a secondary dock returns focus to the visible More trigger when closed

  Scenario: Account loading does not flash in the service header
    Given the hosted viewer resolves account details asynchronously
    When I GET /a/:id
    Then the account slot stays empty until the account response is ready
    And the header does not render a temporary loading spinner

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
