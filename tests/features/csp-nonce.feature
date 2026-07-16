Feature: Self-hosted mermaid + nonce-only CSP close the inline-JS jsdelivr bypass
  As a deploy operator
  I want runtime libraries served same-origin and viewer/user inline scripts gated by a per-request nonce
  So that an artifact's inline JS can no longer createElement("script") to load arbitrary external packages

  Scenario: Opt-in deploy serves a nonce-only script-src with no external host and no unsafe-inline
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS
    And an artifact is served
    Then the CSP script-src contains a 'nonce-<value> token
    And the CSP script-src contains 'self'
    And the CSP script-src does not contain 'unsafe-inline'
    And the CSP script-src does not contain cdn.jsdelivr.net
    And the CSP script-src does not contain 'strict-dynamic'

  Scenario: Default deploy also drops unsafe-inline and carries a nonce
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And an artifact is served
    Then the CSP script-src contains a 'nonce-<value> token
    And the CSP script-src contains 'self'
    And the CSP script-src does not contain 'unsafe-inline'
    And the CSP script-src does not contain 'strict-dynamic'

  Scenario: Every viewer-injected inline script carries the nonce attribute
    When an artifact is served
    Then each inline <script> in the served HTML carries nonce="<nonce>"

  Scenario: User-authored inline <script> in an HTML artifact carries the nonce
    Given an HTML artifact whose body contains <script>console.log(1)</script>
    When the artifact is served
    Then the served HTML has nonce="<nonce>" on that user <script>

  Scenario: Encrypted (unlock shell) view parent carries the nonce on inline scripts
    When an encrypted artifact is served
    Then the unlock-shell inline <script> elements carry nonce="<nonce>"
    And the parent CSP carries a 'nonce-<value> token

  Scenario: The mermaid bundle is served same-origin with a JavaScript MIME and nosniff
    When a request hits GET /vendor/mermaid.runtime.js
    Then the response is JavaScript with content-type text/javascript
    And the response carries x-content-type-options: nosniff

  Scenario: An artifact cannot load an external script — no host is in script-src
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS
    Then a createElement("script", {src: <external URL>}) is blocked by the CSP
    Because no external script host is allowlisted
