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

  Scenario: The thread is inlined into the encrypted unlock shell chrome
    Given a password-protected artifact has a persisted comment
    When a viewer GETs /a/:id
    Then the comment is inlined into the unlock shell chrome at serve time
    And the comments drawer is visible around the (still-locked) body
    And the ciphertext body is not leaked into the thread

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
    Then the host page CSP has connect-src 'self' (drawer may POST comments)
    And the artifact frame CSP has connect-src 'none' (opaque sandbox, no runtime fetch)
    And the frame cannot reach the API — comments reach it only via host postMessage of the serve-time-inlined thread
    # Live no-reload fan-out across concurrent viewers is still deferred (Durable
    # Object). The host/frame split already landed; a WebSocket can later live on
    # the host without widening the iframe CSP.
    # Phase 3 (voice) is out of scope.
