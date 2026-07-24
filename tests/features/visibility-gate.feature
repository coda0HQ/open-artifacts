Feature: Visibility gate on read paths
  As a SaaS operator
  I want private artifacts hidden from unauthorized viewers
  So that tenant content does not leak via share URLs

  Scenario: Private artifact returns 404 on viewer frame
    Given a private artifact created via a stub Authorizer
    When an unauthorized viewer requests /a/:id/frame
    Then the response status is 404

  Scenario: Private artifact returns 404 on raw API
    Given a private artifact created via a stub Authorizer
    When an unauthorized viewer requests GET /api/artifacts/:id/raw
    Then the response status is 404

  Scenario: Private artifact returns 404 on OG card
    Given a private artifact created via a stub Authorizer
    When an unauthorized viewer requests /og/:id
    Then the response status is 404

  Scenario: Owner can change visibility via PATCH
    Given a private artifact and an Authorizer that allows canManage
    When the owner PATCHes visibility to public
    Then the response status is 200
    And the artifact visibility is public

  Scenario: Unauthorized PATCH does not disclose private artifact existence
    Given a private artifact and an Authorizer that denies canManage
    When an unauthorized caller PATCHes visibility
    Then the response status is 404

  Scenario: Write token still authorizes PUT without session write
    Given a public artifact with a write token
    When I PUT new content with the write token bearer
    Then the response status is 200
