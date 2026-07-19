Feature: Configurable content cap

  As a self-hoster on a paid Cloudflare plan
  I want to raise the content cap via an env var without editing source
  So that I can publish larger artifacts than the free-tier default allows

  The 4 MiB cap is a deliberate free-tier default. Setting MAX_CONTENT_MIB
  raises it; leaving it unset keeps the default byte-for-byte unchanged. Raising
  it far past a few MiB risks the Cloudflare Worker request-body / memory limit
  (the body is buffered and held as a JS string), so it is at the operator's own
  risk.

  Scenario: Default cap unchanged
    Given no MAX_CONTENT_MIB override
    When a 5 MiB artifact is published
    Then it is rejected with 413

  Scenario: Raised cap on a self-hosted instance
    Given MAX_CONTENT_MIB=12
    When a 10 MiB artifact is published
    Then it is accepted
    And a 13 MiB artifact is rejected with 413

  Scenario: An invalid override falls back to the 4 MiB default
    Given MAX_CONTENT_MIB is set to a non-positive or non-numeric value
      (including partial parses like "12abc" and non-integers like "12.5")
    When a 5 MiB artifact is published
    Then it is rejected with 413

  Scenario: The raised cap applies to updates as well as creates
    Given MAX_CONTENT_MIB=12 and an existing artifact
    When a 10 MiB update is published
    Then it is accepted
    And a 13 MiB update is rejected with 413

  Scenario: A PUT with an oversized declared body is rejected before parsing
    Given no MAX_CONTENT_MIB override
    When an update declares a content-length past the derived body cap
    Then it is rejected with 413
    And the same declared length is accepted under MAX_CONTENT_MIB=12

  Scenario: The builder output gate honors the default cap
    Given no MAX_CONTENT_MIB override
    When a recipe builds output larger than 4 MiB
    Then the build fails naming the service limit and makes no publish request

  Scenario: The builder output gate honors a raised cap
    Given MAX_CONTENT_MIB=12
    When the same over-4-MiB recipe is built
    Then the build succeeds because the output is under the raised cap
