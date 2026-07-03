Feature: Agent skill for creating and maintaining artifacts
  As a user of any coding agent
  I want to install a skill via npx
  So that my agent can publish artifacts and keep them updated as my project evolves

  Scenario: Create an artifact via the skill script
    Given a project directory and a local HTML file "report.html"
    When the agent runs the artifact script with create, a title, a favicon, and a scope description
    Then the artifact is published to the configured API
    And a manifest entry is written to .artifacts/manifest.json
    And the manifest entry records the id, url, write token, scope, and watch globs

  Scenario: Update an artifact via the skill script
    Given a manifest entry for artifact "abc"
    When the agent runs the artifact script with update abc and a new HTML file
    Then the artifact content at the same URL is replaced
    And the manifest entry's content hash is refreshed

  Scenario: Detect stale artifacts after code changes
    Given a manifest entry watching "src/**/*.ts" with a recorded snapshot hash
    And files matching the watch glob have changed since the snapshot
    When the agent runs the artifact script with status
    Then the script reports the artifact as stale
    And exits with a nonzero code so agents notice

  Scenario: Password-protected publish from the skill
    Given a local HTML file and a password
    When the agent runs the artifact script with create and --password
    Then the content is encrypted locally before upload
    And the plaintext never leaves the machine

  Scenario: Status with no manifest is a no-op
    Given a project directory without .artifacts/manifest.json
    When the agent runs the artifact script with status
    Then the script exits 0 and reports nothing to do
