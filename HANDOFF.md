# Open Artifacts Evaluation Handoff

> Historical audit record for the fixed upstream baseline. Implementation has
> since moved into this repository; current status and evidence are tracked in
> `docs/project-plan.md` and `docs/releases/p0-evidence.md`.

- Date: 2026-08-04
- Upstream: <https://github.com/coda0HQ/open-artifacts>
- Audited commit: `a03a8c3721dd0021c78ea24533d6f7a7f4af07b3`
- Detailed implementation specification: [`SPEC.md`](./SPEC.md)

## User intent

The user is deciding whether Open Artifacts can serve as the foundation for continued product development. The important distinction is not just shareable HTML: the desired value is a shareable artifact that retains source/provenance, versions, feedback, and an agent-assisted iteration loop. The user also compared it with ChatGPT/Codex Sites and correctly identified maintainability and continued iteration as the key decision axis.

## Decision reached

Treat Open Artifacts as a **forkable product kernel**, not as a production-ready dependency to consume directly from `main`.

- Good now: internal prototype and architectural reference.
- Good after a hardening milestone: team-grade, self-hosted artifact service.
- Not recommended unchanged: public, customer-facing production platform.
- Prefer ChatGPT Sites when the actual need is simply managed creation, sharing, hosting, and ongoing page edits.
- Prefer an Open Artifacts fork when self-hosting, cross-agent operation, Recipe/Manifest provenance, and infrastructure-level control are strategic requirements.

## Work completed

The upstream repository was inspected at the commit above. The durable result of that work is the adjacent `SPEC.md`; it contains the quality assessment, target architecture, P0/P1 requirements, acceptance criteria, security model, rollout sequence, and source links.

Verification results from the audit:

- Worker suite: 342 tests passed across 26 files.
- CLI suite: 149 tests passed across 4 files.
- Static check: 93 files passed.
- Reported typecheck passed, but current configuration does not truly typecheck CLI `.mjs` code.
- Real-browser Live E2E failed twice at the same point after inline copy-edit Save: the expected “Apply copy edits (1)” action did not appear.
- Production dependency audit found one moderate Hono advisory with a patch available.
- Full audit found two high and five moderate advisories, predominantly in the Cloudflare development toolchain.

At the time of this historical audit, no source code had been modified, forked, deployed, or pushed; the audit workspace contained planning documents only. That statement does not describe the current implementation repository.

## Highest-risk findings

1. D1 metadata and R2 blob writes do not form an atomic publication. The current pointer may advance before all content/version writes succeed.
2. The browser-level Live copy-edit path is reproducibly red.
3. CI and protected deployment gates are absent; CLI JavaScript is not genuinely typechecked.
4. Public write/comment/Live endpoints need rate limits, quotas, and clearer authorization defaults.
5. Local manifest/credential writes need atomic rename and locking; token rotation and recovery need product design.
6. The audited upstream permitted in-place Live replacement; the implemented foundation now uses revisioned Drafts and immutable Checkpoints.
7. Schema migrations, backup/restore, telemetry, and repair workflows need production treatment.
8. Cloudflare is a real architectural dependency. Supporting another host will require adapter/refactor work, not just a deployment setting.

## Recommended next actions

1. Resolve the open product decisions in `SPEC.md`, especially internal versus public launch, Cloudflare commitment, anonymous comments, and Live version semantics.
2. Fork upstream, pin the audited commit, and define ownership plus upstream-sync policy.
3. Add required CI; fix actual `.mjs` typechecking; patch Hono.
4. Reproduce the Live E2E failure with traces and diagnose whether it is a browser-driver compatibility issue or a product regression.
5. Implement the publication state machine using immutable blobs, a D1 transactional commit, compare-and-swap, idempotency, repair, and failure injection.
6. Add abuse controls, credential lifecycle, crash-safe local state, versioned migrations, backups, observability, and runbooks.
7. Only after P0 is green, decide whether provider portability and larger module refactors belong in the next milestone.

## Suggested skills for the next session

- `diagnose`: isolate the reproducible Live copy-edit E2E failure before changing behavior.
- `tdd`: implement publication consistency and crash-safe local state from acceptance tests.
- `planner`: turn `SPEC.md` into a sequenced engineering plan with ownership and dependencies.
- `to-issues`: split the approved specification into reviewable GitHub issues after the fork exists.

## Completion boundary

This handoff completes the research-and-specification stage only. Implementation begins when the user authorizes creating or cloning the fork and selects the initial product boundary. No deployment or external write has been performed.
