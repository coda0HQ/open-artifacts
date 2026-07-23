Feature: CLI SaaS login client
  As a SaaS user publishing from the CLI
  I want artifact login to exchange an OAuth code for an sk_ API key
  So that programmatic create uses revocable credentials

  Scenario: Login builds a provider-specific OAuth URL
    Given a configured SaaS instance URL
    When I inspect the CLI login URL for provider github
    Then the URL includes /auth/github/login with cli=1 and a loopback redirect_uri

  Scenario: Login stores sk_ from exchange on success
    Given a mock SaaS instance with /api/keys/exchange
    When I complete artifact login with a callback code
    Then credentials.json contains the returned apiKey

  Scenario: Login against the open-source engine fails gracefully
    Given a self-hosted engine without /api/keys/exchange
    When I run artifact login
    Then the command fails with an exchange-unavailable message

  Scenario: whoami prefers stored sk_ over createToken
    Given credentials.json has an sk_ API key and config has createToken
    When I run artifact whoami
    Then the request uses the sk_ bearer token

  Scenario: Login times out if the browser never returns
    Given a configured SaaS instance URL
    When I start artifact login and no callback arrives before the timeout
    Then the command fails with a login timed out message
