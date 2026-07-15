Feature: Opt-in runtime libraries (mermaid via jsdelivr CDN)
  As an artifact author on a deploy that opted into runtime libraries
  I want to declare an allowlisted library loaded from jsdelivr
  So that text-authored diagrams render

  Scenario: Script surface is off by default
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    Then the CSP omits cdn.jsdelivr.net from script-src
    And a jsdelivr <script src> is blocked by the CSP at runtime

  Scenario: Build gate rejects a non-jsdelivr remote <script src>
    Given a recipe whose body contains <script src="https://evil/x.js">
    When the build runs validate
    Then validation fails with a script-src message
    And no request is recorded

  Scenario: Build gate rejects a jsdelivr package off the allowlist
    Given a recipe whose body contains <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js">
    When the build runs validate
    Then validation fails naming "d3" as off the allowlist

  Scenario: Build gate rejects an inline <script> in the body
    Given a recipe whose body contains <script>alert(1)</script>
    When the build runs validate
    Then validation fails with a body-fragment message

  Scenario: Build gate accepts an allowlisted jsdelivr <script src>
    Given a recipe whose body contains <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    And a <pre class="mermaid">flowchart LR\nA-->B</pre> diagram
    When the build runs validate
    Then validation passes

  Scenario: Build gate validates mermaid syntax and rejects a broken diagram
    Given a recipe whose body contains <pre class="mermaid">flowchart LR\nA->>B [[[</pre>
    When the build runs validate
    Then validation fails with a "mermaid syntax error" message
    And the failure names the diagram block and mermaid's parse error

  Scenario: Build gate passes valid mermaid across diagram types
    Given a recipe whose body contains a flowchart, a sequenceDiagram, and a classDiagram
    When the build runs validate
    Then validation passes
