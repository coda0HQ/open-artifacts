Feature: Atomic publication visibility

  As a reader of an artifact
  I want Latest to reference only a fully stored immutable version
  So that a storage or metadata failure never exposes a partial publication

  Scenario: Blob storage fails during an update
    Given an artifact is committed at version 1
    And blob storage rejects the version 2 write
    When a writer attempts to publish version 2
    Then the publication fails
    And Latest still points to version 1
    And version 1 content remains readable

  Scenario: An idempotent update response is lost and retried
    Given an update commits with an actor-scoped idempotency key
    When the same actor retries the same payload with the same key
    Then the same publication id and version are returned
    And no duplicate visible version is created

  Scenario: An idempotency key is reused for different content
    Given an update commits with an actor-scoped idempotency key
    When the same actor reuses the key for a different payload
    Then the service returns an idempotency conflict
    And the committed artifact is unchanged
