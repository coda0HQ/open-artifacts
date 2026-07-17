Feature: Opt-in same-origin web fonts
  As an artifact author on a deploy that opted into web fonts
  I want the design sub-agent to pick a Fontshare family and have it load same-origin
  So that editorial and display register artifacts gain character without opening the CSP to a third party

  Scenario: Web-font surface is off by default
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And I GET /fonts/general-sans--400.woff2
    Then the response status is 404
    And no request reaches Fontshare

  # The artifact document is /a/:id/frame since the host/frame split; /a/:id is
  # the privileged host page and never carries a sandbox directive at all.

  # R1 is unconditional, not something each call site opts into. The old
  # sandbox builder added allow-same-origin whenever web fonts were on unless a
  # caller passed a "keep it strict" flag — so a new route that forgot the flag
  # would silently open the air-gap. The builder now never emits it at all.

  Scenario: A sandboxed CSP never grants allow-same-origin, whatever the arguments
    Given the content-security-policy builder
    When it builds a sandboxed policy with web fonts enabled
    Then the sandbox directive omits allow-same-origin
    And there is no argument that adds it back

  Scenario: Web-font surface turns on with the deploy flag
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    And I GET /a/:id/frame
    Then the Content-Security-Policy allows fonts from the font CDN allowlist
    And font-src names the response origin, because 'self' cannot match from an opaque origin
    And the sandbox directive still omits allow-same-origin, so the air-gap holds

  Scenario: Non-opt-in deploy keeps the strict sandbox
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And I GET /a/:id/frame
    Then the Content-Security-Policy allows fonts only from data:
    And the sandbox directive omits allow-same-origin

  Scenario: The host page is never widened by the web-font opt-in
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    And I GET /a/:id
    Then the host Content-Security-Policy is unchanged by the flag
    And it carries no sandbox directive, because the host is not the artifact

  Scenario: .woff2 is materialized from Fontshare into R2 on first hit
    Given a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    When I GET /fonts/general-sans--400.woff2
    Then the response status is 200
    And the content-type is font/woff2
    And the cache-control is immutable
    And the R2 bucket gains the fonts/general-sans--400.woff2 key

  Scenario: Second hit serves from R2 without re-fetching Fontshare
    Given a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    And /fonts/general-sans--400.woff2 has already been materialized into R2
    When I GET /fonts/general-sans--400.woff2 again
    Then the response status is 200
    And no additional request reaches Fontshare

  Scenario: .css shim returns a derived @font-face
    Given a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    When I GET /fonts/general-sans--400.css
    Then the response status is 200
    And the content-type is text/css
    And the body is a single @font-face whose src points at /fonts/general-sans--400.woff2

  Scenario: Unknown slug 404s without proxying an arbitrary host
    Given a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    When I GET /fonts/this-family-does-not-exist--400.woff2
    Then the response status is 404
    And no request reaches a host other than api.fontshare.com

  Scenario: Malformed slug 404s
    Given a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    When I GET /fonts/no-weight.woff2
    Then the response status is 404
