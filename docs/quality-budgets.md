# Quality budgets

The release gate combines deterministic static budgets with runtime budgets. `config/quality-budgets.json` is the single owner-reviewed source; `pnpm check:budgets` performs a real Wrangler dry-run and fails when the Worker upload, generated Viewer runtime, server template, or CLI composition root exceeds its ceiling.

Current static ceilings leave deliberate but finite headroom over the 2026-08-04 baseline: the Worker is capped at 7 MiB raw / 3.5 MiB gzip, Viewer runtime at 110 KiB, `wrap.ts` at 1,800 lines, and `artifact.mjs` at 400 lines. Source maps and static asset manifests are not counted as Worker runtime bytes; JavaScript and WASM are.

`tests/ops/quality-budgets.test.ts` measures composition startup, in-memory Blob read/write p95, and heap growth. The production-shaped load profile measures Publish, Read, Comment, and Live p95; its thresholds must exactly match `stagingP95Ms`, which the static checker enforces. These local measurements are regression sentinels, not a substitute for the Staging SLO dashboard.

Changing a ceiling requires benchmark evidence and review by Platform / SRE. A temporary exception must record `name`, `owner`, `reason`, and a future `expiresAt`; expired or incomplete exceptions fail CI. Permanent unexplained increases are not accepted.
