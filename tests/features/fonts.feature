Feature: Opt-in same-origin web fonts
  As an artifact author on a deploy that opted into web fonts
  I want the design sub-agent to pick a Fontshare family and have it load same-origin
  So that editorial and display register artifacts gain character without opening the CSP to a third party

  Scenario: Web-font surface is off by default
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And I GET /fonts/general-sans--400.woff2
    Then the response status is 404
    And no request reaches Fontshare

  Scenario: Web-font surface turns on with the deploy flag
    When a deploy sets OPEN_ARTIFACTS_WEB_FONTS=1
    And I GET /a/:id
    Then the Content-Security-Policy allows same-origin fonts
    And the sandbox directive includes allow-same-origin

  Scenario: Non-opt-in deploy keeps the strict sandbox
    When a deploy does not set OPEN_ARTIFACTS_WEB_FONTS
    And I GET /a/:id
    Then the Content-Security-Policy allows fonts only from data:
    And the sandbox directive omits allow-same-origin

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
