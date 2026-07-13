Feature: Password-protected artifacts
  As a user sharing sensitive content
  I want my artifact encrypted with a password
  So that only people who know the password can read it, and the server never sees plaintext

  Scenario: Publish an encrypted artifact
    Given HTML content encrypted client-side with AES-GCM using a key derived from "hunter2"
    When I POST the ciphertext envelope to /api/artifacts with encrypted true
    Then the response status is 201
    And the server stores only ciphertext, salt, and iv

  Scenario: Viewing an encrypted artifact prompts for a password
    Given a published encrypted artifact
    When I GET /a/:id
    Then the response is an unlock page that contains no plaintext content
    And the unlock page fetches the ciphertext and decrypts it in the browser

  Scenario: Correct password decrypts the artifact
    Given the unlock page for an encrypted artifact
    When the viewer enters "hunter2"
    Then the decrypted HTML replaces the page content

  Scenario: Wrong password fails to decrypt
    Given the unlock page for an encrypted artifact
    When the viewer enters "wrong"
    Then decryption fails
    And an error message is shown without revealing any content

  Scenario: Raw endpoint of an encrypted artifact never returns plaintext
    When I GET /api/artifacts/:id/raw for an encrypted artifact
    Then the response is the ciphertext envelope, not HTML

  Scenario: A local Recipe with misplaced fragments reports both rules at once
    Given a local Recipe placed correctly under .artifacts/recipes.local/ but
      whose fragments live outside .artifacts/fragments.local/
    When the agent runs the artifact script with validate
    Then the build fails naming the fragments.local/ rule and the ../fragments.local/
      traversal in a single message
    And no publish request is made

  Scenario: A local Recipe misplaced alongside its fragments reports both rules at once
    Given a local Recipe whose file and fragments both live outside the .artifacts/
      private source directories
    When the agent runs the artifact script with validate
    Then the build fails naming both the recipes.local/ rule and the fragments.local/
      rule in a single message, so the author moves everything in one attempt
