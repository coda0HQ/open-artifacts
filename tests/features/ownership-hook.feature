Feature: Ownership hook on create
  As a SaaS operator
  I want artifact creation to pass through an Authorizer hook
  So that ownership and visibility can be stamped per tenant

  Scenario: Authorizer rejects create
    Given a custom Authorizer that returns null from authorizeCreate
    When I POST a valid artifact
    Then the response status is 401

  Scenario: Authorizer stamps ownership on create
    Given a custom Authorizer that grants ownerId and visibility
    When I POST a valid artifact
    Then the stored artifact carries the granted ownerId and visibility

  Scenario: Default authorizer keeps public open-create behavior
    Given the default Authorizer with no CREATE_TOKEN
    When I POST a valid artifact
    Then the response status is 201
    And the artifact visibility is public
