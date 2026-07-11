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
