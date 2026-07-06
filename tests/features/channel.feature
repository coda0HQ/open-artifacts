Feature: Channel-bound publishing
  As a coding agent publishing from CI or a recurring workflow
  I want every publish with the same channel token to land on one stable URL
  So that viewers always follow the same link no matter how often I republish

  Scenario: First publish with a channel creates the artifact
    Given a create request carrying channel token "ch_x"
    When I POST it to /api/artifacts
    Then the response status is 201
    And the response echoes the channel token

  Scenario: Later publishes with the same channel update the same URL
    Given an artifact already bound to channel token "ch_x"
    When I POST new content with channel token "ch_x"
    Then the response status is 200
    And the artifact id and URL are unchanged
    And the artifact version increments

  Scenario: A channel can never bind to two artifacts
    Given two publishes race to be the first with channel token "ch_x"
    When both POST to /api/artifacts concurrently
    Then exactly one artifact exists for channel "ch_x"
    And both publishes land on that artifact's URL
