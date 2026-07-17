Feature: Anonymous writes are rate-limited (R5)

  # Two endpoints take anonymous writes and persist a D1 row each:
  #   POST /comments  — open on EVERY instance, gated or not.
  #   POST /feedback  — open on an instance with no CREATE_TOKEN.
  # The content-length precheck bounds one row's size, not the number of rows,
  # so a client that knows an artifact id can flood either table without bound.
  # A per-IP, per-artifact token bucket (30 writes / 10 min) bounds the rate
  # above that precheck.
  #
  # The bucket is keyed on CF-Connecting-IP, which Cloudflare's edge sets and
  # overwrites on every request, so a client cannot spoof its way into a fresh
  # bucket.

  Scenario: An anonymous comment flood is throttled
    Given a published artifact
    When the same client POSTs 30 comments within the window
    Then every one of them is accepted
    When that client POSTs one more comment
    Then the response status is 429
    And the response carries a Retry-After header
    And the comment is not persisted in D1

  Scenario: The bucket is per-client
    Given a client has exhausted its bucket on an artifact
    When a different client POSTs a comment to that artifact
    Then the response status is 201

  Scenario: The bucket is per-artifact
    Given a client has exhausted its bucket on an artifact
    When that same client POSTs a comment to a different artifact
    Then the response status is 201

  Scenario: The bucket refills over time
    Given a client has exhausted its bucket on an artifact
    When the refill interval for one token has elapsed
    Then that client may post one more comment
    But a second immediate post is rejected with 429

  Scenario: An idle bucket banks no credit past its capacity
    Given a client that spent one token and then sat idle
    When it writes again before the bucket has fully refilled
    Then it may write up to the bucket's capacity
    But not one write more — idle time earns no burst beyond a full bucket

  Scenario: Throttling applies on a gated instance too
    # CREATE_TOKEN gates artifact creation, not commenting — /comments is open
    # on every instance, so the bucket is what bounds it there as well.
    Given CREATE_TOKEN is set on the instance
    And a published artifact
    When an anonymous client POSTs past the bucket
    Then the response status is 429

  Scenario: Reads are not throttled
    Given a client has exhausted its bucket on an artifact
    When that client GETs the comment thread
    Then the response status is 200

  # /feedback is the other anonymous write surface. It queues work for the
  # owning agent rather than a thread for viewers, but the exposure is the
  # same shape: a row per request, bounded per row and not in number.

  Scenario: An anonymous feedback flood is throttled
    Given an open instance and a published artifact
    When the same client POSTs 30 feedback items within the window
    Then every one of them is accepted
    When that client POSTs one more
    Then the response status is 429
    And the response carries a Retry-After header
    And the feedback is not persisted in D1

  Scenario: Feedback and comments do not share a budget
    # Separate key namespaces on one artifact: a viewer who has been chatting
    # in the thread must still be able to report a problem to the agent.
    Given a client has exhausted its comment bucket on an artifact
    When that client POSTs feedback to the same artifact
    Then the response status is 201

  Scenario: A gated instance refuses anonymous feedback before the bucket
    # Unlike /comments, /feedback is not open on a gated instance: the write
    # token is required. A rejected request writes no row, so it needs no
    # bucket — auth already bounds it.
    Given CREATE_TOKEN is set on the instance
    When an anonymous client POSTs feedback
    Then the response status is 401
    And no token is spent

  Scenario: Concurrent writes cannot both take the last token
    Given a bucket with a single token left
    When several writes for it arrive at once
    Then exactly one is accepted
    And the rest are rejected

  # A bucket row is spent state, not content: once it has fully refilled it
  # says nothing, so it is pruned. Otherwise the limiter would itself become
  # the unbounded-growth vector it exists to prevent — an attacker rotating
  # IPs would mint a permanent row per address.

  Scenario: Fully refilled buckets are pruned
    Given a bucket row that has sat idle past its full refill
    When any client consumes a token
    Then the stale row is gone from D1
    And the active row remains

  # The compose panel's own guards are UX, not security — the bucket above is
  # authoritative. The panel already refuses to submit while a post is in
  # flight; the cooldown stops a held Enter from spending the real budget on
  # duplicates and locking the thread out for everyone behind that address.

  Scenario: The panel absorbs key-repeat before it reaches the bucket
    Given a viewer just posted a comment
    When they submit again within the cooldown
    Then the panel sends no second request

  Scenario: A throttled viewer is told what to do
    Given the server refuses a comment with 429
    When the panel reports it
    Then the viewer reads that they should try again shortly
    And not a bare status code
