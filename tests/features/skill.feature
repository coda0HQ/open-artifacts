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

  Scenario: Creating an artifact leaves hook installation to the user
    Given a Claude Code session with CLAUDE_PROJECT_DIR set to the project
    When the agent runs the artifact script with create in that session
    Then no Stop hook is installed automatically
    And the output hints that install-hook enables end-of-turn staleness checks
    So that whether to install the hook stays the user's choice

  Scenario: Acknowledge drift without republishing
    Given a stale manifest entry whose watched files changed but do not affect it
    When the agent runs the artifact script with ack for that entry
    Then the snapshot baseline advances to the current file hashes
    And no request is sent to the server
    And a subsequent status reports the artifact as up to date

  Scenario: The staleness hook stays quiet when already continuing
    Given a stale artifact and a Stop hook invocation with stop_hook_active true
    When the agent runs the artifact script with status --hook on that input
    Then the script emits nothing and exits 0 so Claude is allowed to stop

  Scenario: Turning on auto-update for one artifact leaves every other artifact untouched
    Given manifest entries for artifacts "auto-a" and "auto-b", neither opted into auto-update
    When the agent runs the artifact script with auto-update auto-a on
    Then the auto-a manifest entry's autoUpdate becomes true
    And the auto-b manifest entry's autoUpdate is unchanged
    So that toggling one artifact's auto-update never leaks into another's state

  Scenario: Turning on auto-update installs the Stop hook as the user's explicit consent
    Given a Claude Code session with CLAUDE_PROJECT_DIR set to the project
    And a manifest entry for artifact "abc" with a write token on file
    When the agent runs the artifact script with auto-update abc on
    Then a Stop hook is installed in .claude/settings.json
    And the output confirms the hook was installed
    So that the hook is only ever installed as the direct result of a visible command, never silently

  Scenario: The Stop hook only surfaces artifacts opted into auto-update
    Given a stale artifact "auto-a" with autoUpdate true and a stale artifact "auto-b" without autoUpdate set
    When the agent runs the artifact script with status --hook
    Then the hook JSON mentions auto-a but not auto-b
    And a plain status still reports both artifacts as stale
    So that the hands-off Stop-hook loop only ever acts on artifacts the user opted in, while a human's manual check keeps full visibility

  Scenario: The skill asks about local mode on first publish and recommends local
    Given a project directory without any .artifacts/manifest.json or .artifacts/manifest.local.json
    When the agent is about to publish its first artifact
    Then the skill asks the user whether the artifact should be local (machine-private, gitignored)
    And recommends local as the default
    So that whether the manifest is committed to the repo is the user's choice, not a silent default

  Scenario: Publishing with --local writes to the gitignored local manifest
    Given a project directory and a local HTML file "report.html"
    When the agent runs the artifact script with create and --local
    Then the manifest entry is written to .artifacts/manifest.local.json
    And .artifacts/manifest.json is not created
    And .artifacts/manifest.local.json is added to .gitignore
    And the write token is still stored in the single .artifacts/credentials.json

  Scenario: Reads merge the shared and local manifests, local overriding
    Given a shared manifest with an entry for id "abc" titled "Shared"
    And a local manifest with an entry for id "abc" titled "Local"
    When the agent runs the artifact script with list
    Then the output shows the entry titled "Local"
    And does not show "Shared"
    So a machine-local override takes precedence over the committed entry

  Scenario: Update requires a file and regenerates from the server's current version
    Given a manifest entry for artifact "abc"
    When the agent runs the artifact script with update abc and no file
    Then the script fails with a message explaining a file is required
    So that no stale local source copy is assumed to exist

  Scenario: Publishing a canvas artifact records the mode orthogonally to level
    Given a project directory and a local HTML file "board.html"
    When the agent runs the artifact script with create, --level 2, and --canvas
    Then the manifest entry records level 2 and canvas true
    And neither level nor canvas is sent to the server
    So that the shell and the fidelity are chosen independently

  Scenario: Re-publishing without --canvas returns the artifact to a document
    Given a manifest entry for a channel published with --canvas
    When the agent runs the artifact script with create on the same channel without --canvas
    Then the manifest entry records canvas false
    So that a redesign back to a scrolling document is never silently overridden

  Scenario: An invalid level is still rejected with --canvas
    Given a project directory and a local HTML file "flow.html"
    When the agent runs the artifact script with create, --level 4, and --canvas
    Then the script fails with a message naming level
    So that --canvas never loosens level validation
