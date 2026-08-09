Feature: Crash-safe credentials and lifecycle
  As a user persisting artifact encryption passwords on disk
  I want the credentials file written with restrictive permissions
  So that no other OS user on the machine can read my write tokens or passwords

  Scenario: create with --password writes credentials.json as 0600
    Given a Recipe encrypted with a named password credential
    When I run create with the password in the environment
    Then the publish succeeds
    And .artifacts/credentials.json exists with file mode 0o600 on Unix

  Scenario: a pre-existing 0644 credentials.json is migrated to 0600 on load
    Given a credentials.json written with mode 0o644 by an older CLI version
    When I run any command that loads credentials
    Then the file mode is tightened to 0o600

  # mutateCredentials re-reads before write so a concurrent token survives.
  # Encrypted migrate must also resolve the stored password after its GET —
  # a dangling pre-network `credentials` binding crashes that path (#38).
  Scenario: Migrating an encrypted legacy artifact uses the stored password
    Given a legacy encrypted artifact with its password in credentials.json
    When I run migrate for that artifact
    Then the Recipe is written without a ReferenceError
    And the stored password is copied into namedPasswords

  Scenario: Update re-reads credentials before writing a password back
    Given an encrypted Recipe already published
    And another process writes a token into credentials.json during the PUT
    When I run update for that artifact
    Then the concurrent token is still present after the update

  Scenario: Concurrent state mutations are serialized
    Given four CLI processes share one state file
    When each process performs twenty-five read-modify-write operations
    Then all one hundred operations are present
    And the state checksum is valid

  Scenario: Rotate with no grace revokes the old write token immediately
    Given an artifact with an active write credential
    When I rotate it with zero grace seconds
    Then the new write token is stored without being printed
    And the old write token is rejected

  Scenario: Manager recovery revokes all old credentials
    Given every locally stored write token is unavailable
    When an authorized manager recovers the artifact credential
    Then exactly one new primary credential is active
    And prior credentials remain revoked
