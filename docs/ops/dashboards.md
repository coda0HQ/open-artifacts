# Operational dashboards

The production overview is sourced from the `METRICS` Analytics Engine dataset. It uses only the bounded schema emitted by `src/telemetry/metrics.ts`: environment index; metric, route, operation, result, and status-class blobs; value, duration, and HTTP-status doubles. Request, artifact, actor, publication, and trace identifiers stay in redacted structured logs and are never chart labels.

## Required boards

| Board | Panels | Target freshness | Owner |
| --- | --- | --- | --- |
| Release health | request rate/error class/p50-p95 duration, publish success/conflict/failure, state failures, missing blobs | 2 minutes | Platform on-call |
| Abuse and security | auth failures, rate-limited operations, exact quota exhaustion by bounded route, anonymous-surface state | 2 minutes | Security on-call |
| Live | connect/draft/checkpoint/rollback outcomes and latency, conflict ratio, DO failure rate | 2 minutes | Realtime on-call |
| Capacity and cost | requests, D1/R2 operations, stored-byte growth, versions/comments/handoffs, estimated daily spend | 15 minutes | SRE |
| Recovery | stale publications, reconciliation results, backup age, restore duration and validation result | 15 minutes | SRE |

Every board has Preview, Staging, and Production filters based only on index 1. A synthetic staging event is emitted after deployment and must appear within two minutes; failure triggers `telemetry-silence`.

## Query contract

Analytics Engine fields are interpreted as follows:

| Field | Meaning |
| --- | --- |
| `index1` | environment |
| `blob1` | metric name |
| `blob2` | bounded route |
| `blob3` | bounded operation |
| `blob4` | bounded result |
| `blob5` | status class |
| `double1` | count/value |
| `double2` | duration in milliseconds |
| `double3` | numeric status |

Example publication panel query (the deployment substitutes the dataset name):

```sql
SELECT blob4 AS result, SUM(double1) AS operations,
       quantileWeighted(double2, 0.95, double1) AS p95_ms
FROM open_artifacts_metrics
WHERE index1 = 'production' AND blob1 = 'publication_operation'
  AND timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY result
```

Dashboard configuration changes require the same review as alert thresholds. A screenshot is useful evidence, but `config/observability/alerts.json` and query results are the executable source of truth.
