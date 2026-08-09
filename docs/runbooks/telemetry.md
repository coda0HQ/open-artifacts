# Telemetry Silence

Owner: SRE on-call. Treat silence in a serving production environment as P0.

1. Check Worker deployment health and Analytics Engine binding availability independently; absence of traffic must be proven from edge request totals, not assumed.
2. Verify `METRICS`, `TELEMETRY_ENV`, and structured-log delivery configuration for the active immutable Worker version.
3. Send one authenticated read and one intentionally rejected request using synthetic staging credentials. Confirm both have a request ID and bounded metric dimensions.
4. If only metrics are unavailable, preserve structured logs and page the telemetry provider. If both are unavailable, halt deployments and public writes until correlation is restored.
5. Roll back the application only when the prior version is schema compatible. Otherwise roll forward the binding/configuration fix.
6. Resolve after two evaluation windows contain both `http_request` and synthetic probe events. Attach query output and deployment version to the incident.
