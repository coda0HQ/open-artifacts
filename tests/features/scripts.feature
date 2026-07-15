Feature: Runtime libraries (mermaid self-hosted same-origin)
  As an artifact author
  I want to declare an allowlisted library loaded same-origin from /vendor
  So that text-authored diagrams render with no external script host in the CSP

  Scenario: The mermaid bundle is served same-origin
    When a request hits GET /vendor/mermaid.runtime.js
    Then the response is JavaScript served with nosniff
    And no external script host appears in any artifact CSP

  Scenario: Build gate rejects a non-allowlisted same-origin /vendor path
    Given a recipe whose body contains <script src="/vendor/evil.runtime.js"></script>
    When the build runs validate
    Then validation fails with a script-src message
    And no request is recorded

  Scenario: Build gate rejects an external remote <script src>
    Given a recipe whose body contains <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    When the build runs validate
    Then validation fails naming the same-origin /vendor/requirement

  Scenario: Build gate rejects an inline <script> in the body
    Given a recipe whose body contains <script>alert(1)</script>
    When the build runs validate
    Then validation fails with a body-fragment message

  Scenario: Build gate rejects a module <script src> for mermaid (load-order bug)
    Given a recipe whose body contains <script type="module" src="/vendor/mermaid.runtime.js"></script>
    When the build runs validate
    Then validation fails with a load-order message
    And no request is recorded

  Scenario: Build gate accepts an allowlisted same-origin regular <script src> for mermaid
    Given a recipe whose body contains <script src="/vendor/mermaid.runtime.js"></script>
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
