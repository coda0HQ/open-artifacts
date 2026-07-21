Feature: Instance identity beyond the landing page
  As a visitor of an artifact page, its header, or its error states
  I want every touchpoint that names the service to agree on whose instance it is
  So that a branded deploy reads as its brand everywhere, not just on "/"

  Scenario: The viewer header names the configured brand and links home
    Given a published artifact
    When I GET /a/:id with BRAND_NAME set to "coda0"
    Then the header shows a "coda0" brand chip linking to "/"

  Scenario: A self-hosted deploy without BRAND_URL shows no brand chip
    Given a published artifact
    When I GET /a/:id on a self-hosted host with no BRAND_URL set
    Then the header shows no brand chip

  Scenario: A self-hosted deploy with BRAND_URL shows the neutral Open Artifacts credit
    Given a published artifact
    When I GET /a/:id on a self-hosted host with BRAND_URL set to its own URL
    Then the header shows an "Open Artifacts" brand chip linking to that BRAND_URL

  Scenario: A branded deploy ignores a stray BRAND_URL and still links home
    Given a published artifact
    When I GET /a/:id with BRAND_NAME set and BRAND_URL set to something else
    Then the header still shows a brand chip linking to "/", not to BRAND_URL

  Scenario: Not-found reads "Go to" the configured brand
    When I GET /a/nonexistent with BRAND_NAME set to "coda0"
    Then the response status is 404
    And the page links "Go to coda0"

  Scenario: Not-found reads "Go to Open Artifacts" without brand env
    When I GET /a/nonexistent without brand env
    Then the response status is 404
    And the page links "Go to Open Artifacts"

  Scenario: Invalid version reads "Go to" the configured brand
    Given a published artifact
    When I GET /a/:id?v=notanumber with BRAND_NAME set to "coda0"
    Then the response status is 400
    And the page links "Go to coda0"

  Scenario: The OG card wordmark uses the configured brand wordmark
    Given an artifact's title and description
    When the OG card SVG is built with BRAND_NAME "coda0" and BRAND_WORDMARK "CODA0"
    Then the card's wordmark reads "CODA0" instead of "OPEN ARTIFACTS"
