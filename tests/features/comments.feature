Feature: Multi-user interaction on a shared artifact

  Scenario: A comment posted via the API is persisted server-side (D1)
    Given a published artifact
    When a client POSTs a comment to /api/artifacts/:id/comments
    Then the response status is 201
    And the comment is persisted in D1

  Scenario: The thread appears for all future viewers
    Given an artifact has a persisted comment
    When a viewer GETs /a/:id
    Then the comment is inlined into the page at serve time
    And the thread is visible in the comments drawer

  Scenario: Comment validation guards the API
    When a POST /api/artifacts/:id/comments omits the body
    Then the response status is 400
    When a POST /api/artifacts/:id/comments sends a body over the size limit
    Then the response status is 413

  Scenario: Listing comments returns the thread in chronological order
    Given an artifact has three comments posted in sequence
    When a viewer GETs /api/artifacts/:id/comments
    Then the comments are returned oldest-first by created_at

  Scenario: The artifact body remains sandboxed
    Given a comments drawer is rendered around the artifact
    Then the viewer page CSP still has connect-src none
    And realtime fetching is impossible from the page (comments are inlined at serve time, not fetched at runtime)
    # Phase 2 (live, no-reload fan-out via Durable Object) is deferred: it
    # requires splitting the viewer into an outer host page + sandboxed iframe
    # so a WebSocket can live in the outer page without widening the iframe CSP.
    # Phase 3 (voice) is out of scope.
