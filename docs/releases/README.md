# Release records

This directory contains the evidence and operator records used to promote one
immutable commit. Repository tests prove that the controls are executable;
they do not impersonate an independent reviewer or a remote Cloudflare drill.

- [P0 evidence pack](p0-evidence.md)
- [Security release review](../security/release-review.md)
- [Release rehearsal](rehearsal.md)
- [Canary and promotion](canary.md)
- [Browser support and bounded exceptions](browser-support.md)
- [v1.0.0-rc.1 release notes](v1.0.0-rc.1.md)
- [Post-launch review](post-launch-review.md)

Production promotion is valid only when the immutable release manifest, a
successful remote Staging receipt, reviewer identities, and Canary observations
all refer to the same full Git commit.
