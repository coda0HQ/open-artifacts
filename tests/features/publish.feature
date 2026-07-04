Feature: Publish an artifact
  As a coding agent
  I want to publish a self-contained HTML or Markdown file as a hosted artifact
  So that my user can share a rendered page with others via a URL

  Scenario: Publish a new HTML artifact
    Given a self-contained HTML fragment with title "Sprint Report" and favicon "📊"
    When I POST it to /api/artifacts
    Then the response status is 201
    And the response contains an artifact id, a public URL, and a write token
    And the artifact version is 1

  Scenario: Publish a Markdown artifact
    Given a Markdown document with title "Design Notes" and favicon "📝"
    When I POST it to /api/artifacts with format "markdown"
    Then the response status is 201
    And viewing the artifact renders the Markdown as HTML

  Scenario: Reject content that is too large
    Given an HTML document larger than the maximum allowed size
    When I POST it to /api/artifacts
    Then the response status is 413

  Scenario: Reject a request without required fields
    When I POST to /api/artifacts without a title or content
    Then the response status is 400
    And the response body explains which field is missing

  Scenario: Reject a favicon that is not emoji
    Given a create request with favicon "<script>"
    When I POST it to /api/artifacts
    Then the response status is 400

  Scenario: Title is extracted from a title tag in the content
    Given HTML content containing "<title>From The Tag</title>" and no explicit title
    When I POST it to /api/artifacts
    Then GET /api/artifacts/:id reports title "From The Tag"

  Scenario: The public URL uses the instance's canonical domain when configured
    Given the instance is deployed with PUBLIC_URL set to its SaaS domain
    When I POST a valid artifact, whatever host the request arrived on
    Then the returned url and the page's og:url and og:image use the SaaS domain

  Scenario: Without PUBLIC_URL the public URL follows the request origin
    Given the instance is deployed without PUBLIC_URL
    When I POST a valid artifact
    Then the returned url uses the host the request arrived on

  Scenario: Gated instance requires the create token
    Given the instance is deployed with a CREATE_TOKEN secret
    When I POST a valid artifact without the create token
    Then the response status is 401
    When I POST the same artifact with the create token as bearer auth
    Then the response status is 201
