Feature: Per-request nonce + strict-dynamic close the inline-JS jsdelivr bypass
  As a deploy operator who opted into runtime libraries
  I want viewer-injected inline scripts to run under a per-request nonce
  So that an artifact's inline JS can no longer createElement("script") to load arbitrary jsdelivr packages

  Scenario: Opt-in deploy serves a nonce'd, strict-dynamic script-src with no unsafe-inline
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS
    And an artifact is served
    Then the CSP script-src contains a 'nonce-<value> token
    And the CSP script-src contains 'strict-dynamic'
    And the CSP script-src contains cdn.jsdelivr.net
    And the CSP script-src does not contain 'unsafe-inline'

  Scenario: Default deploy also drops unsafe-inline and carries a nonce
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And an artifact is served
    Then the CSP script-src contains a 'nonce-<value> token
    And the CSP script-src contains 'strict-dynamic'
    And the CSP script-src does not contain 'unsafe-inline'
    And the CSP script-src does not contain cdn.jsdelivr.net

  Scenario: Every viewer-injected inline script carries the nonce attribute
    When an artifact is served
    Then each inline <script> in the served HTML carries nonce="<nonce>"

  Scenario: Encrypted (unlock shell) view parent carries the nonce on inline scripts
    When an encrypted artifact is served
    Then the unlock-shell inline <script> elements carry nonce="<nonce>"
    And the parent CSP carries a 'nonce-<value> token

  Scenario: Authored allowlisted jsdelivr <script src> still loads via strict-dynamic
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS
    And the CSP script-src has 'strict-dynamic'
    Then a nonce'd parent script may load a child <script src> from cdn.jsdelivr.net
    But a runtime createElement("script") without the nonce is blocked
