Feature: CLI JavaScript is covered by static type checks

  As a maintainer of the published agent skill
  I want every executable MJS file to be checked by TypeScript
  So that JavaScript argument and return-type regressions cannot pass CI silently

  Scenario: The CLI TypeScript project includes executable MJS sources
    Given the skill CLI entry point and library modules are JavaScript MJS files
    When the CLI TypeScript project is resolved
    Then allowJs and checkJs are enabled
    And artifact.mjs and its library modules are included in the program

  Scenario: A bad JavaScript call is rejected
    Given a JavaScript function whose JSDoc parameter type is number
    When the CLI TypeScript settings check a call with a string
    Then the compiler reports a type error
