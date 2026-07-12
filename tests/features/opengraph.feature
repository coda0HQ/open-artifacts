Feature: Rich link previews
  As someone sharing an artifact link
  I want chat apps and social platforms to show a rich preview
  So that recipients see what the artifact is before they open it

  Scenario: Artifact pages carry OpenGraph and Twitter metadata
    Given a published artifact with a title and description
    When I GET /a/:id
    Then the head contains og:title, og:description, and og:url for the artifact
    And the head contains og:site_name set to the host's brand name
    And the document title is the artifact title suffixed with the brand name and tagline
    And the head contains twitter:card set to summary_large_image
    And og:image points at the absolute /og/:id URL
    And og:image:type is image/png with width 1200 and height 630

  Scenario: The preview description falls back to the title
    Given a published artifact with no description
    When I GET /a/:id
    Then og:description and twitter:description use the artifact title

  Scenario: Metadata values are HTML-escaped
    Given an artifact whose title contains markup
    When I GET /a/:id
    Then the markup is escaped in every meta tag

  Scenario: The OG image is a raster PNG crawlers can render
    Given a published artifact
    When I GET /og/:id
    Then the response is an image/png rendered from the artifact title and description
    And the card is drawn with embedded fonts and makes no external request
    And the card carries a call-to-action pill

  Scenario: CJK titles render as real headlines on the card
    Given a published artifact whose title is Simplified Chinese
    When I GET /og/:id
    Then the card draws the title with the embedded Noto Sans SC face
    And a title in a script with no embedded glyphs falls back to the brand card

  Scenario: Encrypted artifacts still get a preview
    Given a password-protected artifact
    When I GET /a/:id
    Then the unlock shell carries the same OpenGraph and Twitter metadata

  Scenario: Unknown artifact has no card
    When I GET /og/:id for an id that does not exist
    Then the response status is 404
