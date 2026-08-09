# Abuse, Rate Saturation, and Quota Exhaustion

Owner: Security on-call with Platform support.

1. Identify the bounded route and hashed actor dimension; do not recover or log raw IP addresses or bearer credentials.
2. Distinguish `rate_limited` (short burst), `quota_exhausted` (durable resource policy), and `auth_failure` (credential probing).
3. Disable anonymous create/comments first. Tighten the affected route's soft limiter only within the documented policy range; never raise exact quotas during an active attack.
4. Revoke a compromised credential by hash and rotate the owner credential. Keep the raw replacement solely in the configured Secret Store.
5. Verify the service returns controlled `401`, `403`, `429`, or quota `409` responses and that healthy authenticated reads remain available.
6. Close only after rejection volume and storage growth return to baseline for 30 minutes. Record the policy change, rollback time, and affected hashed scopes.
