Feature: Controlled production release
  The release owner must be able to prove that one immutable candidate is safe,
  recoverable, and progressively promoted without trusting an author checkbox.

  Scenario: Remote environments never share stateful resources
    Given Preview, Staging, and Production Wrangler configurations
    When the environment isolation gate runs
    Then Worker, domain, D1, R2, Analytics, and rate-limit identities are distinct
    And anonymous writes default to disabled
    And runtime secrets are not committed as variables

  Scenario: A candidate rebuild is reproducible
    Given a full Git commit, frozen lockfile, schema migrations, and Worker bundle
    When release metadata is built twice with the same source date epoch
    Then the manifest, CycloneDX SBOM, provenance, and checksums are byte-identical
    And a mutable ref or modified tracked source is rejected

  Scenario: A dangerous surface can be contained without losing reads
    Given an enabled operational kill switch for writes, Live, or comments
    When a matching API mutation arrives
    Then the service returns a structured 503 response naming the active switch
    And safe read methods remain available

  Scenario: Viewer accessibility is a release gate
    Given an artifact in either supported theme and a 360 pixel viewport
    When a keyboard user operates the Viewer with reduced motion
    Then focus is visible and controls expose their state
    And the document does not overflow horizontally
    And automated WCAG 2.2 A and AA checks report no violations

  Scenario: Production expands only after evidence
    Given an approved immutable candidate and successful Staging receipt
    When the invited-team Canary satisfies its observation window
    Then promotion requires the prior phase receipt digest and named approvers
    And any Missing Blob, authorization regression, or schema mismatch aborts
