# Workflow automation and generic integrations

Milestone 7 reuses this worker and transport for on-call escalation. Rules additionally support `alert.create`; `alert.opened` and `alert.occurrenceAdded` are transactional triggers. Integration outbound allowlists may include `escalation.advanced` for on-call webhooks. Signed inbound version 2 creates routed alerts while version 1 remains compatible. See [on-call alert contracts and delivery guarantees](ONCALL.md).

## Processes and deployment

The API accepts domain mutations and management commands. A separate worker polls MongoDB for durable events and runs; execution survives API process restarts. Start infrastructure with `docker compose up -d --wait`, then `npm run dev`. Start the worker separately with `npm run worker:dev -w @flowryn/api`. Production uses `npm run build`, `npm run start -w @flowryn/api`, and `npm run worker:start -w @flowryn/api` in independently supervised processes. Multiple workers may share the same database. Every worker generates a unique UUID.

MongoDB replica-set or sharded-cluster transactions and initialized unique indexes are mandatory. API and worker startup validate topology and encryption configuration. Production API processes continue to require Redis for authorization/realtime coordination. The worker does not require Redis: optional Redis messages are disposable UI invalidation hints, never durable event sources. Missing hints are repaired by REST polling and reconnection. Worker `/health` and `/ready` listen on localhost port 4001 by default; proxy these internally if container probes need access. Readiness becomes false after database claim failure and during shutdown. Do not expose worker health endpoints publicly.

Configuration:

| Variable                     | Meaning                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AUTOMATION_ENCRYPTION_KEYS` | JSON mapping key versions to independently generated 32-byte keys encoded as 64 hex characters; required in every environment |
| `AUTOMATION_KEY_VERSION`     | Current write key version, default `1`; must exist in the key map                                                             |
| `AUTOMATION_CONCURRENCY`     | Active work bound per worker, integer 1–16, default 4                                                                         |
| `AUTOMATION_POLL_MS`         | Poll interval, 250–30000 ms, default 1000                                                                                     |
| `AUTOMATION_HEALTH_PORT`     | Worker health listener, default 4001                                                                                          |

Generate local keys outside source control, for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Put the result in the private `.env` key map. Never commit real encryption or signing keys. Test suites use isolated keys and mock network/DNS adapters.

SIGINT/SIGTERM stops claims, drains active work, closes hint connections and health server, and disconnects MongoDB. Supervisors should allow enough time for bounded webhook requests plus MongoDB transaction completion. A hard kill leaves 60-second leases that another worker recovers. Run leases renew every 15 seconds; unique claim tokens fence all action/result writes. Clocks on API/worker hosts must be synchronized; lease deadlines use application UTC clocks. MongoDB interruptions leave durable work recoverable rather than acknowledging it.

## Rules and event contracts

`packages/shared/src/automation.ts` is the version-1 Zod contract. Rule management requires an active owner/admin, and all normal resource queries include the authenticated workspace. Members may view safe rule state; run details, integration configuration, delivery history, dead letters and metrics require administrators. Rules have monotonically increasing versions and stable UUID action IDs; edits require the version read by the client. Archiving disables future matching, while already queued runs retain their evaluated snapshots.

Supported triggers: `incident.declared`, `incident.severityChanged`, `incident.statusChanged`, `incident.commanderChanged`, `incident.responderChanged`, `incident.timelineAdded`, `incident.resolved`, `incident.reopened`, `task.created`, `task.assigned`, `task.statusChanged`, `automation.manual`. Incident outbox events commit beside state, append-only timeline, activity and notifications. Task create/update/status/assignment paths share a transactional service. Task reordering and deletion are outside the supported trigger allowlist.

Payloads contain identifiers, severity/status, assignments and declaration time only, with a 16 KiB byte bound. They omit titles, descriptions, timeline narrative, runbook instructions and signing material. Incident project conditions match membership in the linked-project snapshot. Snapshot time, rather than current worker time, defines integer elapsed declaration minutes.

Conditions use `{ field, operator: "eq" | "in", values }` leaves and `{ mode: "all" | "any", children }` groups. Empty `all` matches; empty `any` does not. Missing fields never match. Array fields match when any element belongs to the value set. `eq` takes exactly one value. Maximum depth is 4, total nodes 32, membership values 32, ordered actions 16, and active rules 100 per workspace. Strings and reference arrays have explicit bounds. No code, arbitrary query, regex, dynamic import or shell action is accepted.

Actions: timeline update, task creation, allowlisted task title/priority/status update, active-member task assignment, private notification, active runbook attachment, severity change, valid incident transition, and approved webhook. Signed alert/manual rules also support incident declaration from explicitly configured action fields. Incident transitions use the existing state machine and require a resolution summary to resolve. Archived incidents and inactive projects cannot be mutated. References are revalidated at execution, including membership and current integration event allowlists.

The execution identity is `flowryn:automation:v1` (reserved actor ObjectId `000000000000000000000006`). It is an internal Symbol capability, not an account, token, role inherited from a creator, or user-controlled field. It permits only automation's incident commands and task fields. Runs and audit records preserve both the configuring human and any initiating human. Removing a creator does not convert the system into that removed user's identity.

## Delivery, idempotency and loops

Events are claimed atomically and matched rules are snapshotted in a transaction before event completion. Unique workspace/rule/event receipts deduplicate matching. Runs persist ordered action state. Every database action commits its effect, audit, generated events, and succeeded result in the same transaction. A recovered run skips completed actions. Stable run/action operation UUIDs deduplicate incident receipts, notifications and webhook delivery records. Task effects rely on the transactional run-action completion fence, preventing duplicate task creation after an ambiguous commit or crash.

Processing is **at least once**. Database observable effects within these transactions are idempotent. Outbound HTTP effects cannot participate in MongoDB transactions: a remote success followed by a worker crash can cause the same signed delivery ID to be sent again. Receivers must deduplicate delivery IDs. Flowryn does not promise exactly-once distributed execution. Failed ordered actions stop the remainder; automatic retries resume at the failed action. Partial success followed by permanent/exhausted failure becomes `partiallyFailed`.

Correlation IDs survive a generated chain; causation IDs identify the triggering event. Each generated event carries the visited rule path. A rule executes at most once on a causal path, covering immediate and indirect cycles. Events at chain depth 8 produce skipped loop-protected runs. Separate human operations create independent causal roots.

Temporary failures use capped exponential delays plus 0–999 ms jitter. A retry cycle allows five claims, including crash recovery claims. Exhausted events become `dead`; exhausted runs become failed/partially failed. Administrators can replay dead events or retry failed runs; completed actions and existing event/run receipts remain intact. Replay does not retry an already-created failed run: use the run retry endpoint separately. Processed outbox documents expire after 90 days; run and delivery receipts are retained to protect idempotency. Dead events do not expire automatically. Plan operational retention and database capacity accordingly.

## API

Authenticated base: `/api/workspaces/:workspaceId/automation`. IDs must be MongoDB ObjectIds. List endpoints accept bounded `page` and `limit` (default 20, max 100). Runs additionally accept `ruleId`, `status`, `from`, `to` (ISO UTC). Rules and integrations accept `archived=true`.

| Method   | Path                                            | Body / behavior                                                                                   |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET/POST | `/rules`                                        | List/create versioned rule                                                                        |
| GET      | `/rules/:ruleId`                                | Retrieve                                                                                          |
| PUT      | `/rules/:ruleId`                                | `{ version, rule }`; optimistic concurrency                                                       |
| POST     | `/rules/validate`                               | Rule schema and workspace references                                                              |
| POST     | `/rules/:ruleId/enable`, `/disable`, `/archive` | `{}`                                                                                              |
| POST     | `/rules/:ruleId/dry-run`                        | `{ operationId, incidentId?, taskId? }`; evaluates conditions, returns action preview, no effects |
| POST     | `/rules/:ruleId/execute`                        | Same target body; only enabled manual rules; reuse operation ID when response is ambiguous        |
| GET      | `/runs`, `/runs/:runId`                         | Sanitized execution/action history                                                                |
| POST     | `/runs/:runId/cancel`                           | Queued only                                                                                       |
| POST     | `/runs/:runId/retry`                            | Failed/partially failed only                                                                      |
| GET      | `/dead-letters`                                 | Sanitized event metadata; no payload                                                              |
| POST     | `/dead-letters/:eventId/replay`                 | Dead only; `eventId` here is the document ObjectId                                                |
| GET/POST | `/integrations`                                 | List/create; secret returned only at creation                                                     |
| GET/PUT  | `/integrations/:integrationId`                  | Retrieve/update safe metadata                                                                     |
| POST     | `/integrations/:integrationId/rotate`           | New secret once; invalidates old signing secret immediately                                       |
| POST     | `/integrations/:integrationId/archive`          | Reject future inbound/outbound work                                                               |
| POST     | `/integrations/:integrationId/test`             | Queue a synthetic run with the first approved outbound event                                      |
| GET      | `/integrations/:integrationId/deliveries`       | Sanitized persistent delivery history                                                             |
| GET      | `/metrics`                                      | Server-side aggregation; optional creation-cohort date filters                                    |

Rule bodies contain name, description, enabled, trigger type/version, conditions, actions, and optional `inboundIntegrationId`. Integration bodies contain name, `type: "genericWebhook"`, `status: "active" | "disabled"`, optional endpoint, inbound allowlist (`alert.received`), and outbound trigger allowlist.

## Signing and inbound alerts

Inbound POST `/api/webhooks/:workspaceId/:integrationId` requires `Content-Type: application/json`, raw uncompressed body <=16 KiB, and headers:

- `x-flowryn-timestamp`: Unix seconds, within 300 seconds.
- `x-flowryn-delivery-id`: UUID, unique for the integration/workspace.
- `x-flowryn-signature`: hex HMAC-SHA256 over `timestamp + "." + deliveryId + "." + rawBody`, using the generated secret as UTF-8 bytes.

Version-1 body: `{ "schemaVersion": 1, "eventType": "alert.received", "severity": "sev3", "incidentId": "optional workspace incident ObjectId", "status": "optional incident status" }`. Do not reserialize the body between signing and sending. Verification precedes JSON parsing; signatures compare fixed-length buffers with `timingSafeEqual`. Delivery receipts and event insertion commit together. Requests are limited to 60/minute per integration/workspace via durable MongoDB buckets; also enforce global request/IP limits at the ingress proxy to bound unauthenticated traffic across invented integration IDs. Invalid requests only affect rate-limit buckets and never create domain work, events or accepted delivery receipts. Errors are generic.

An active integration must explicitly allow inbound alerts. Only enabled manual rules whose `inboundIntegrationId` matches that integration may receive them. Rule actions explicitly configure all domain effects; arbitrary webhook fields cannot patch incidents. Cross-workspace incident targets are rejected before event creation. Inbound replay is denied, including concurrent attempts.

Outbound bodies contain `schemaVersion`, event ID/type, correlation ID and safe data. Headers additionally include `x-flowryn-event-id` and `x-flowryn-schema-version`; signing uses the same scheme above. Connection/TLS timeout is 3 seconds, total DNS/request timeout 10 seconds, response headers 8 KiB, response body 8 KiB. Full response bodies, credentials and sensitive headers are never persisted.

## SSRF and credentials

Outbound requests require HTTPS on port 443 in every environment. Userinfo, query strings (which may carry secrets), fragments, single-label/internal names and every redirect are rejected; the redirect limit is zero. All DNS answers must pass the public-address policy; the HTTPS request uses a custom lookup pinned to one approved answer with normal hostname TLS verification and no reused agent. IPv4 denies private, loopback, link-local, shared, benchmark, documentation, multicast and reserved ranges. IPv6 conservatively allows only allocated RIR blocks from the [IANA global unicast registry](https://www.iana.org/assignments/ipv6-unicast-address-assignments) (2025-10-10): `2003::/18`, `2400::/12`, `2410::/12`, `2600::/12`, `2610::/23`, `2620::/23`, `2630::/12`, `2800::/12`, `2a00::/12`, `2a10::/12`, and `2c00::/12`. Unallocated/reserved blocks, all `2001::/16`, `2002::/16`, and special transition addresses are denied; IPv4-mapped and zoned addresses are denied. Some otherwise public IPv6 endpoints are deliberately excluded by this conservative policy. Network egress controls should independently restrict destinations.

Signing secrets use AES-256-GCM authenticated encryption with random 96-bit IVs and AAD binding workspace, integration and key version. Keys come exclusively from configuration. Stored secrets never appear in management reads, audits, errors or realtime envelopes. Rotation generates a new secret and reencrypts using the current key. For encryption-key migration: distribute a key map containing old and new versions to every process, switch current version, rotate integrations, then remove old keys only once no record references them. Rotation intentionally replaces the signing secret, so update external senders/receivers together. Do not remove old encryption keys prematurely.

Runtime primitives are documented in [Node HTTPS](https://nodejs.org/docs/latest-v22.x/api/https.html) and [Node crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html).

## Realtime and metrics

Typed empty-payload rule-state hints use authorized workspace rooms. All run lifecycle and integration health/failure hints go only to active owner/admin private workspace-user rooms, and never carry snapshots, HTTP bodies, signing material, stack traces or error narrative. Every API subscriber emits locally to avoid adapter duplicates; clients deduplicate UUIDs, restore subscriptions and invalidate REST caches. Redis outages can lose these hints without losing execution state.

Metrics use MongoDB facets and aggregation pipelines scoped by workspace and optional run/delivery creation cohort. Rates count `succeeded` versus `failed + partiallyFailed`; skipped/cancelled/in-flight runs are excluded. Retried runs remain one run whose final current state defines rates. Retry count is lifetime claims after the first claim, including crash recovery and manually initiated retry cycles. Duration averages terminal executing runs with start/completion timestamps, including retry waiting time from first start to final completion. Skipped/cancelled runs contribute no duration sample. Webhook rates count final succeeded/failed outbound delivery records, not HTTP attempts; inbound and pending deliveries are excluded. Daily executions count run creation in UTC, including skipped/cancelled runs. Frequently failing rules count failed/partially failed current runs. Dead-letter count reflects currently dead events, so replay reduces it.
