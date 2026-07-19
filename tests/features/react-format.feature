Feature: React/JSX artifact format
  A first-class "react" format precompiles JSX at build time and inlines React
  into a single self-contained IIFE. The bundle renders under the existing strict
  viewer CSP — nonce-only script-src, no 'unsafe-eval', no external script host —
  so the security model is unchanged; only the skill build pipeline gains a JSX
  compile step and the viewer frame gains a mount node.

  Scenario: Publish a precompiled React component
    Given a recipe with format "react" and a default-export component
    When the skill builds it
    Then the published content is one self-contained IIFE with React inlined
    And the artifact frame mounts it into a root node under a nonce'd inline script
    And no external script host appears in the CSP
    And 'unsafe-eval' is absent from script-src

  Scenario: The compiled bundle evaluates no code at runtime
    Given a recipe with format "react" and a default-export component
    When the skill builds it
    Then the compiled bundle contains no eval and no new Function
    And the compiled bundle loads no external script

  Scenario: Reject in-browser JSX transforms
    Given a react recipe whose entry relies on an in-browser Babel transform
    When the skill builds it
    Then the build fails with a "precompile JSX" error

  Scenario: React recipes are body-only with a single entry
    Given a react recipe that declares theme or script fragments
    When the skill builds it
    Then the build fails asking for a single body entry component

  Scenario: The server accepts the react format
    Given a create request with format "react"
    When the API validates it
    Then the format is accepted

  Scenario: Encrypted react artifacts neutralize a literal </script in the bundle
    Given a password-protected react artifact whose bundle contains a literal "</script"
    When the viewer decrypts and splices the bundle into the frame's inline script
    Then the "</script" is escaped to "<\/script" so the inline script is not broken
    And the escape mirrors the plain path's escapeInlineScript
    And the html and markdown decrypt paths are unchanged

  Scenario: A single React runtime is bundled even when the entry has its own react
    Given a react entry component that sits next to a local node_modules/react
    When the skill precompiles the component
    Then the bundle uses only the skill runtime React
    And the entry-local React copy is not inlined
