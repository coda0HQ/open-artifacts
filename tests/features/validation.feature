Feature: Build validation catches silent layout defects

  As an agent authoring an artifact
  I want the build to fail when a CSS container class is defined but never applied
  So that content never ships spanning 100% of the viewport because the measure
  cap referenced a class the markup forgot to use

  Scenario: A container class defined in CSS but absent from the body fails validation
    Given an HTML recipe whose theme or styles define a class with a measure constraint
      (max-width) but the body fragment never applies that class
    When the agent runs the artifact script with validate
    Then the build fails with a message naming the unapplied container class
    And no publish request is made

  Scenario: A container class that the body actually applies passes validation
    Given an HTML recipe whose styles define .report with a max-width and the body
      wraps its content in <main class="report">
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A bare body element used as the container passes validation
    Given an HTML recipe whose styles set max-width on body itself rather than a class
    When the agent runs the artifact script with validate
    Then the build succeeds because the constraint lives on an element, not a class

  Scenario: A level 1 non-canvas HTML page with no measure cap fails validation
    Given an HTML recipe at level 1 that defines no max-width anywhere in its
      theme or styles and does not use the .oa-prose baseline
    When the agent runs the artifact script with validate
    Then the build fails with a message pointing the author to the .oa-prose baseline
      or a measure cap on body
    And no publish request is made

  Scenario: A level 1 page using the .oa-prose baseline passes validation
    Given an HTML recipe at level 1 whose body wraps content in main.oa-prose
    When the agent runs the artifact script with validate
    Then the build succeeds because the .oa-prose baseline supplies the measure cap

  Scenario: A level 2 or 3 page with no measure cap passes validation
    Given an HTML recipe at level 2 that defines no max-width anywhere
    When the agent runs the artifact script with validate
    Then the build succeeds because the measure-cap guard only applies to level 1

  Scenario: A start tag carrying style= twice fails validation
    Given an HTML recipe whose body fragment authors a single start tag with two
      style attributes, so the second value is silently dropped by the HTML parser
    When the agent runs the artifact script with validate
    Then the build fails with a message telling the author to merge both into one style attribute
    And no publish request is made

  Scenario: A start tag with a single style attribute passes validation
    Given an HTML recipe whose body fragment uses one style attribute per element
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: A CSP-forbidden token appearing only inside a comment passes validation
    Given an HTML recipe whose script fragment mentions a CSP-forbidden API like fetch()
      solely in a comment, with no real call in executable code
    When the agent runs the artifact script with validate
    Then the build succeeds because comments are not executable

  Scenario: A real CSP-forbidden call in executable code fails validation
    Given an HTML recipe whose body fragment calls a forbidden API in executable code
    When the agent runs the artifact script with validate
    Then the build fails naming the forbidden API as incompatible with the CSP
    And no publish request is made

  Scenario: A Markdown recipe without a document.theme field passes validation
    Given a Markdown recipe that omits document.theme entirely
    When the agent runs the artifact script with validate
    Then the build succeeds because document.theme is an optional label with no runtime effect

  Scenario: An authored dark --muted below 4.5:1 contrast fails validation
    Given an HTML recipe whose dark theme block overrides --muted to a color whose contrast
      against --bg falls under 4.5:1
    When the agent runs the artifact script with validate
    Then the build fails naming the failing pair and its ratio and the 4.5:1 minimum
    And no publish request is made

  Scenario: An authored dark --muted at or above 4.5:1 contrast passes validation
    Given an HTML recipe whose dark theme block overrides --muted to a sufficiently light gray
    When the agent runs the artifact script with validate
    Then the build succeeds

  Scenario: Migrating a legacy bare-L1 page wraps it in the prose baseline
    Given a legacy level 1 non-canvas artifact whose published content has identity
      tokens but no measure cap and no .oa-prose wrapper
    When the agent runs the artifact script with update to migrate it to a Recipe
    Then the build succeeds because migration wraps the body in main.oa-prose
    And the migrated body fragment contains class="oa-prose"
    And the artifact is not locked out of future updates
