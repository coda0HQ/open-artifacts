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
