# Capacity and cost model

The initial team-service model is intentionally bounded. `config/load-profile.json` is the executable staging profile: 25 iterations, four operations per iteration, at most eight concurrent requests. It covers publish, immutable read, comment, and Live Draft read. Authentication is injected through `OPEN_ARTIFACTS_LOAD_TOKEN`; neither the token nor request content appears in the report.

## Per-iteration demand

| Operation | Worker requests | D1 reads/writes (upper estimate) | R2 reads/writes | DO requests |
| --- | ---: | ---: | ---: | ---: |
| Publish | 1 | 2 / 4 | 1 verify / 1 immutable write | 0 |
| Read | 1 | 2 / 0 | 1 / 0 | 0 |
| Comment | 1 | 2 / 2 | 0 / 0 | 0 |
| Live Draft read | 1 | 1 / 0 | 0 / 0 | 1 |

The profile therefore generates 100 Worker requests, an estimated 175 D1 reads, 150 D1 writes, 50 R2 reads, 25 R2 writes, and 25 DO requests. These are deliberately conservative planning inputs, not invoices. Operators multiply measured daily operation counts by the current Cloudflare plan rates outside the repository; price values are not hard-coded because they change.

## Gates and scaling

- Any network or 5xx response fails the run. Only explicit `401`, `403`, fail-closed/not-yet-created `404`, `409`, `413`, and `429` are controlled rejection outcomes; they are reported separately from success.
- Initial p95 staging budgets are 750 ms for read, 1,000 ms for comment/Live, and 1,500 ms for publish. The release gate permits at most a 10% regression from the recorded staging baseline while remaining below these ceilings.
- Exact quotas are enforced in D1/DO and must reject before unbounded R2/DO growth. Soft rate limits absorb bursts but are never counted as quota correctness.
- Increase concurrency in steps of two, stop at the first p95 budget breach or any 5xx, and preserve the report with deployment/schema identifiers. The script hard-caps concurrency at 20 to prevent an accidental production load test.

Storage forecast is `committed immutable content + retained comments/handoffs + active Drafts + independent backups`. The capacity dashboard tracks actual stored-byte growth. Alert before a projected 30-day trajectory reaches 80% of the configured tenant or platform limit; do not raise a quota without reviewing backup duration, restore RTO, and cost.
