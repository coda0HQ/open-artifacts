Feature: In-place schema migration
  As an operator upgrading a long-running instance
  I want new metadata columns to be added and backfilled automatically
  So that artifacts published before the upgrade keep working with full metadata

  # SCHEMA is the full current shape for fresh DBs. MIGRATIONS ALTERs every
  # column added after v1 so existing DBs catch up. New columns must land in
  # BOTH — a SCHEMA-only column never reaches production DBs; a MIGRATIONS-only
  # column leaves fresh installs depending on an ALTER whose real failures used
  # to be memoized as success (#33).

  Scenario: Version metadata columns are backfilled from the parent artifact
    Given a database created before versions carried title, description, favicon, format, and encrypted columns
    And an artifact with version rows stored under that old schema
    When any request touches the store after the upgrade
    Then the version history reports the artifact's title, favicon, and format for the old rows

  Scenario: A pre-existing database gains every column the current schema declares
    Given a database created at the v1 schema (comments without anchor, delete_token_hash, or done)
    When ensureSchema runs against it
    Then every column SCHEMA declares on comments exists
    And every column MIGRATIONS adds to comments exists

  Scenario: A genuinely failed migration is retried, not memoized as success
    Given a migration that fails for an unexpected reason
    When a later request calls ensureSchema on the same database
    Then the migration is attempted again
