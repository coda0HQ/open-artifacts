# Security policy

## Supported versions

Security fixes are provided for the latest Foundation release and current
`main`. The imported upstream baseline is not a supported production release.

## Reporting a vulnerability

Use GitHub's private security-advisory flow for this repository. Do not open a
public issue with exploit details, credentials, customer data, or unredacted
logs. If private advisories are unavailable, contact the repository owner
through their verified GitHub profile and request a private reporting channel.

Include affected commit/version, deployment assumptions, reproduction steps,
impact, and any safe mitigation. Never include a working production token.

The interim security owner is @Jiqize. Target response times are:

- acknowledgement: 2 business days;
- initial severity/impact assessment: 5 business days;
- critical containment plan: 24 hours after confirmation;
- coordinated disclosure date: agreed with the reporter after a fix exists.

## Scope and safe harbor

In scope: authorization bypass, token exposure, cross-artifact access, sandbox
or CSP escape, stored injection, publication integrity, destructive migration,
quota bypass, and Live isolation. Test only systems and data you own or have
explicit permission to assess. Avoid privacy violations, denial of service,
social engineering, persistence, and data destruction. Good-faith research
within this policy will be handled constructively.
