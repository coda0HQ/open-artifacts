Feature: Instance identity beyond the landing page
  As a visitor of an artifact page, its header, or its error states
  I want every touchpoint that names the service to agree on whose instance it is
  So that coda0.com reads as coda0 everywhere, not just on "/"

  Scenario: The viewer header names coda0 and links home on the hosted host
    Given a published artifact
    When I GET /a/:id on the coda0.com host
    Then the header shows a "coda0" brand chip linking to "/"

  Scenario: A self-hosted deploy without BRAND_URL shows no brand chip
    Given a published artifact
    When I GET /a/:id on a self-hosted host with no BRAND_URL set
    Then the header shows no brand chip

  Scenario: A self-hosted deploy with BRAND_URL shows the neutral Open Artifacts credit
    Given a published artifact
    When I GET /a/:id on a self-hosted host with BRAND_URL set to its own URL
    Then the header shows an "Open Artifacts" brand chip linking to that BRAND_URL

  Scenario: The hosted host ignores a stray BRAND_URL and still identifies as coda0
    Given a published artifact
    When I GET /a/:id on the coda0.com host with BRAND_URL set to something else
    Then the header still shows a "coda0" brand chip linking to "/", not to BRAND_URL

  Scenario: Not-found reads "Go to coda0" on the hosted host
    When I GET /a/nonexistent on the coda0.com host
    Then the response status is 404
    And the page links "Go to coda0"

  Scenario: Not-found reads "Go to Open Artifacts" on any other host
    When I GET /a/nonexistent on any other host
    Then the response status is 404
    And the page links "Go to Open Artifacts"

  Scenario: Invalid version reads "Go to coda0" on the hosted host
    Given a published artifact
    When I GET /a/:id?v=notanumber on the coda0.com host
    Then the response status is 400
    And the page links "Go to coda0"

  Scenario: The OG card wordmark reads CODA0 on the hosted host
    Given an artifact's title and description
    When the OG card SVG is built for the coda0.com host
    Then the card's wordmark reads "CODA0" instead of "OPEN ARTIFACTS"
