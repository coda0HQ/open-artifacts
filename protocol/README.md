# Open Artifacts wire protocol

`protocol/v1/` is the compatibility boundary shared by the Worker, CLI, and Viewer. It contains closed JSON Schemas for Create, Update, CLI Manifest, Live Draft/Checkpoint, responses, and structured errors. Golden payloads live in `tests/fixtures/protocol/v1/`; Worker, CLI, and Viewer tests all consume those exact files.

## Negotiation

HTTP clients SHOULD send `Open-Artifacts-Protocol: 1`. The Worker returns the same header on every `/api/*` response. An absent request header retains compatibility with pre-negotiation v1 clients. A non-empty unsupported version fails closed with `426`, `LIVE_PROTOCOL_UPGRADE_REQUIRED`, and `supportedVersions` instead of guessing how to interpret the payload.

Live write bodies additionally carry `protocolVersion: 1`, because those messages can be persisted or relayed independently of the initiating HTTP headers.

## Compatibility policy

Published schemas under a major directory are immutable except for additive optional fields and clarifications that do not change accepted meaning. Removing a field, making an optional field required, changing an enum or state transition, or changing validation semantics requires a new major directory such as `v2/`.

An incompatible version receives at least one release cycle and at least 90 days of dual-read support. During that window the current response header identifies the selected version, release notes identify the removal date, and deprecated-version usage is observable. Writers switch only after every supported reader accepts the new shape. Security fixes may shorten the window only through a recorded release exception and explicit fail-closed error.

`publish-request.schema.json` remains a deprecated v1 compatibility alias. New clients select `create-request.schema.json` or `update-request.schema.json` explicitly.

## Idempotency and snapshots

Publication idempotency is carried in the `Idempotency-Key` header (8–200 URL-safe characters). Its scope is the authenticated actor plus operation/resource. The same key and canonical request returns the original Publication; the same key with a different canonical request returns `409 IDEMPOTENCY_KEY_REUSED`.

`pnpm check:protocol` compares every v1 schema and Golden Fixture against `tests/snapshots/protocol/v1/catalog.json`. Any byte change therefore requires an intentional, reviewable snapshot update; incompatible changes additionally require a new protocol major version.
