# Browser support for v1.0.0-rc.1

Chromium is the required and supported browser engine for the first
invited-team release candidate. Its complete Viewer, Live, security, load and
WCAG 2.2 AA suite runs on pull requests, `main`, release builds and local
`pnpm verify`.

Firefox and WebKit have explicit temporary exceptions through 2026-08-18 in
[the machine-readable support matrix](../../config/browser-support.json).
They are not silently treated as passing: each exception names an owner,
rationale, 14-day expiry and exit criteria. Shared Worker/DOM/protocol/CSP tests
still constrain standards behavior, but those engines are not supported until
their full Playwright projects become required checks. Expiry without that work
blocks the next release candidate.
