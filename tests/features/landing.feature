Feature: Landing page identity
  As a visitor or a crawler
  I want the landing page to reflect whose instance it is
  So that the hosted service reads as coda0 while self-hosters stay neutral

  Scenario: The hosted host presents as coda0 in the HTML itself
    Given a request for "/" arriving on the coda0.com host
    When the Worker serves the landing page
    Then the title, meta description, and hero are rewritten to coda0 server-side
    And the hero still links the open-artifacts repository

  Scenario: A self-hosted deploy keeps the neutral Open Artifacts identity
    Given a request for "/" arriving on any other host
    When the Worker serves the landing page
    Then the static "Open Artifacts" markup is returned untouched
