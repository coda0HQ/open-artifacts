Feature: Status page actions
  As a visitor viewing a status page
  I want the navigation link and copy button to look identical
  So the page presents a single consistent action style

  Scenario: Sign-in and copy actions share style and size
    Given a private artifact status page
    When the status actions render
    Then the "Sign in" link and the "Copy link" button share one button class
    And that class gives both the same width, height, border, and alignment

  Scenario: Copy feedback appears on the button itself
    Given a private artifact status page
    When I click "Copy link"
    Then the button text changes in place to confirm the result
