Feature: Version selection in the viewer
  As a viewer with a shared link to an artifact that has been updated
  I want to see and switch between its published versions
  So that I can read the revision that was shared with me

  Scenario: A multi-version artifact shows a version picker
    Given an artifact has 3 versions (1, 2, 3) and the current is 3
    When a viewer opens the artifact URL
    Then the chrome renders a version selector listing versions 1..3
    And the current version (3) is marked as selected

  Scenario: Selecting an older version updates the rendered content
    Given the viewer shows version 3 of an artifact
    When the user selects version 1 from the picker
    Then the URL updates to include ?v=1
    And the rendered content is the version-1 snapshot (inlined at serve time)

  Scenario: Version list is inlined at serve time, not fetched at runtime
    Given the artifact is rendered under the sandboxed opaque-origin iframe
    When the page loads inside the sandbox
    Then no network request is made to fetch versions
    And the version list was already embedded in the served HTML

  # The picker shares the header with the title, brand chip and toggles. A
  # version's label can be arbitrarily long, so rendering it as the option's
  # visible text stretches the control and squeezes the title out on a phone.
  Scenario: A labeled version stays compact in the header
    Given version 2 of an artifact has the label "a rather long design-direction label"
    When a viewer opens the artifact URL
    Then the option's visible text is the short form "v2"
    And its label is carried as a title tooltip, not dropped
    And on a narrow viewport the select is width-clamped

  Scenario: Single-version artifact shows no picker
    Given an artifact has only version 1
    When a viewer opens it
    Then no version selector is rendered

  Scenario: Keyboard and both-theme support
    Given the version picker is visible
    Then it is focusable with a visible focus ring
    And it reads correctly under both data-theme="light" and data-theme="dark"
