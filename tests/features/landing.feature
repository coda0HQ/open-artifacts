Feature: Landing page identity
  As a visitor or a crawler
  I want the landing page to reflect whose instance it is
  So that a branded deploy rewrites the home page while self-hosters stay neutral

  Scenario: A branded deploy rewrites the landing page from env
    Given a request for "/" with BRAND_NAME set
    When the Worker serves the landing page
    Then the title, meta description, and hero are rewritten from brand env server-side

  Scenario: A self-hosted deploy keeps the neutral Open Artifacts identity
    Given a request for "/" without brand env
    When the Worker serves the landing page
    Then the static "Open Artifacts" markup is returned untouched
