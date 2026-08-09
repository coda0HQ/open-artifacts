# Token Loss, Rotation, and Recovery

Owner: Security on-call. Recovery approver: Artifact owner or organization administrator.

## Local loss without suspected compromise

1. Stop automated writers so they do not repeatedly fail authorization or overwrite a recovered Secret Store entry.
2. Inspect status with `node "$ARTIFACT_CLI" credentials status <artifact-id>`. Output contains credential IDs and timestamps, never raw tokens.
3. If another active writer still has the capability, rotate from that trusted host with `credentials rotate <artifact-id> --grace 30`, distribute the new token through the Secret Store, and let the grace window expire.
4. If no write capability remains, authenticate as a manager and run `credentials recover <artifact-id>`. Recovery atomically revokes all prior credentials and returns one replacement exactly once.
5. Verify one update succeeds with the replacement and a request using the old credential fails. Confirm no token appears in shell history, logs, Manifest, Recipe, crash output, or Git.

## Suspected compromise

Revoke the identified credential immediately with `credentials revoke <artifact-id> <credential-id>`. If attribution is uncertain, use manager recovery to revoke the full set. Preserve hashed actor/request audit events, review recent versions and comments, and follow the Abuse runbook for repeated failures. Do not extend a grace period during an incident.

If the local `credentials.json` is corrupt, the CLI quarantines it and reports the path. Keep it for forensics, recover through the authorized API, and never reconstruct a capability from a stored hash.
