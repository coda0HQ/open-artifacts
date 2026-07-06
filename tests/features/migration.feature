Feature: In-place schema migration
  As an operator upgrading a long-running instance
  I want new metadata columns to be added and backfilled automatically
  So that artifacts published before the upgrade keep working with full metadata

  Scenario: Version metadata columns are backfilled from the parent artifact
    Given a database created before versions carried title, description, favicon, format, and encrypted columns
    And an artifact with version rows stored under that old schema
    When any request touches the store after the upgrade
    Then the version history reports the artifact's title, favicon, and format for the old rows
