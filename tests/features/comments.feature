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

  # Done hides a comment from the drawer's default view, so resolving one is as
  # consequential as deleting it and carries the same authorization.

  Scenario: The comment author can mark their own comment done
    Given a viewer posted a comment and holds its delete token
    When the viewer PATCHes that comment with done true using the delete token
    Then the response status is 200
    And listing the thread returns the comment with done true
    And the inlined drawer shows the done control as pressed

  Scenario: The artifact owner can mark any comment done
    Given an artifact has a comment posted by someone else
    When the owner PATCHes it with done true using the artifact write token
    Then the response status is 200

  Scenario: A passer-by cannot resolve someone else's comment
    Given an artifact has a comment this viewer did not post
    When the viewer PATCHes it with done true and no bearer token
    Then the response status is 401
    And the comment is still not done
    When the viewer PATCHes it with done true and a wrong token
    Then the response status is 403
    And the comment is still not done

  Scenario: Delete lives in the more menu for the comment author
    Given a viewer posted a comment and holds its delete token
    Then the drawer item exposes a three-dot more menu containing Delete
    And Delete requires the delete-token bearer auth

  Scenario: An owner opening /a/:id?wt=<write token> can delete any comment
    Given an artifact has comments posted by other viewers
    When the owner opens /a/:id with the artifact write token in the query
    Then the write token is stored for this artifact and stripped from the URL
    And every drawer item exposes the more menu with Delete
    And Delete authorises with the artifact write token

  Scenario: A viewer without a token sees no more menu
    Given an artifact has a comment this viewer did not post
    And this viewer holds no artifact write token
    Then the drawer item renders no three-dot more menu

  Scenario: The comment count badge tracks the default view, not the whole thread
    Given an artifact has three comments and all three are marked done
    When a viewer opens the page
    Then the header badge reads zero rather than three
    And the drawer shows "No open comments."
    When the viewer marks one comment not done
    Then the header badge reads one without a reload

  Scenario: A valid comment carrying both a full-size body and an anchor is accepted
    Given a comment whose body is at the body cap and which also carries a text anchor
    When a client POSTs it to /api/artifacts/:id/comments
    Then the content-length precheck does not reject it before validation
    And the response status is 201

  Scenario: Done comments are filtered out of the default drawer view
    Given an artifact has one open comment and one done comment
    When a viewer opens the comments drawer
    Then the Open filter is selected and only the open comment is listed
    When the viewer selects the Done filter
    Then only the done comment is listed
    When the viewer selects the All filter
    Then both comments are listed
