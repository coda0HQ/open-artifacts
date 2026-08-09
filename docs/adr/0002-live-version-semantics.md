# ADR 0002: Live drafts and immutable published versions

- Status: Accepted
- Date: 2026-08-04
- Owner: @Jiqize (interim Foundation maintainer)
- Review date: 2027-02-04

## Context

The upstream Live path can replace the content behind the current version.
That makes version numbers non-auditable and allows reconnects or stale editors
to overwrite published history. Product language also conflates in-progress
edits, saved edits, and published versions.

## Decision

- A **published version** is an immutable `(version, content hash)` record that
  is readable by viewers only after publication commits.
- A **draft** is mutable collaboration state scoped to one artifact, one base
  published version, and authorized actors. It is never returned by the normal
  artifact read path.
- A **revision** is a monotonically increasing draft update. Every accepted
  write names its expected prior revision; stale writes receive a conflict.
- A **checkpoint** publishes the current draft through the shared publication
  service. It creates version `N+1` using compare-and-swap against the draft's
  base version, then advances Latest atomically.
- A **rollback** copies the selected historical content hash into a new
  checkpoint. It never rewinds a pointer to an old version number and never
  mutates the historical row.

State transitions:

```text
published N -> draft(base=N, revision=0)
draft revision R -> draft revision R+1
draft(base=N) -> checkpoint publication -> published N+1
published N+K -> rollback(selected=N) -> published N+K+1
```

Two-editor behavior:

1. Both editors read the same draft revision.
2. The first valid revision update wins.
3. The second receives a structured revision conflict containing the current
   revision; the server never silently applies last-write-wins.
4. A checkpoint based on a no-longer-current published version returns a
   publication conflict and preserves the draft for recovery or rebase.

Reconnect and Durable Object hibernation rebuild presence and connection state
from durable draft records. WebSocket attachments contain only reconstructible
connection metadata. A handoff with an unpublished draft includes a separate
pending-draft descriptor; it never labels draft bytes as a published version.

## Consequences

- Existing `update --live` clients receive a versioned upgrade error once the
  new protocol is enabled.
- Viewer chrome must distinguish Draft, Saving, Conflict, Checkpointing, and
  Published states.
- Repair and retention jobs may expire drafts, but only after the configured
  recovery window and with an auditable outcome.
