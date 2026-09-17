# On-call schedules, alert routing and escalation

Milestone 7 extends the Milestone 6 worker and transactional outbox. Run the same `worker:dev` / `worker:start` command; there is no second timer, Redis job queue, or competing escalation chain. No SMS, phone, email, vendor-specific paging, AI decisions or remediation provider is claimed.

## Permissions

Active workspace members read schedules and safe alerts and acknowledge workspace alerts. Owners/admins manage schedules, policies, routing, integration references, incident links, lifecycle actions, delivery retries and metrics. Execution uses the existing internal automation principal. API routes recheck membership inside mutations; suspended users retain no HTTP or socket access. Every referenced resource belongs to the authenticated workspace.

Self-overrides are disabled by default. An administrator can explicitly enable `allowSelfOverrides` on a schedule. A member must provide themselves as `originalUserId` and own the entire future covered interval; replacements must be active members. Members can cancel their own self-overrides. Admins can create and cancel all overrides. History is retained, including applied and cancelled overrides.

## Schedule semantics

All absolute timestamps are minute-aligned ISO UTC instants. Each ordered layer has a stable UUID, nonempty unique participants, rotation start, and `shiftMinutes` (15–10080). The only initial handoff rule is `elapsedUTC`: participant index is the elapsed absolute duration divided by shift duration, modulo participant count. Layers independently contribute recipients; duplicate recipients are paged once per step.

Coverage optionally restricts local weekdays (Sunday 0 through Saturday 6) and a half-open minute-of-day window. Unrestricted layers cover every instant after their start. Split overnight windows into separate layers. Rotation continues outside coverage, so coverage does not reset rotation position. Disabled/archived schedules and removed, disabled or suspended participants produce gaps rather than silently shifting responsibility to another person.

IANA timezone interpretation uses the runtime's `Intl.DateTimeFormat`, following [ECMA-402 timezone semantics](https://tc39.es/ecma402/#sec-use-of-the-iana-time-zone-database). Rotation durations stay absolute through DST. The spring missing hour has no instants and receives no invented coverage; both instants in a repeated fall hour independently satisfy a matching local window. Inputs use UTC to avoid ambiguous local timestamp conversion. UI forecasts display schedule and viewer timezones. Deploy matching Node/ICU timezone data on all API/worker instances; timezone-rule updates can change future local coverage and should be reviewed with forecasts.

Forecasts cover at most seven days, evaluated at minute resolution with adjacent identical segments combined. Full-schedule gaps mean no layer has an active recipient; layer gaps additionally report missing individual layers. Complexity is bounded to 8 layers, 32 participants per layer, 100 active configurations of each kind. Overrides are half-open and take precedence only over their specified layer and optional original participant. Intersecting noncancelled overrides on the same layer are rejected transactionally using a schedule revision fence. A replacement losing active membership becomes a coverage gap. Cancellation restores the underlying rotation. Cancel outstanding future overrides before removing their layer.

## Policies and routing

Policies have immutable version snapshots in accepted escalations. At most 8 ordered steps and 3 extra repeats are allowed. Delays are minutes from the preceding dispatch; the first delay may be zero, subsequent delays are positive, and all delays are capped at one day. A repeat adds its positive repeat delay and first-step delay. Targets are explicit members, a schedule, linked incident commander, or linked incident responders. Schedule and incident recipients are resolved at dispatch and recorded in durable delivery records; later retries preserve the admitted recipient set and revalidate notification membership. An unavailable target produces an explicit dead-letter gap record.

Routing evaluates all allowlisted conditions in each enabled rule, with ascending numeric priority and stable ObjectId as the tie-breaker. Conditions support integration, severity, exact safe labels, project, service, incident presence, and IANA-local time windows. The first matching active policy wins. Inactive policy targets are skipped. A configured active fallback applies when no route matches; otherwise the alert is accepted as open and unrouted with no pages. Authenticated admins and configured automation may explicitly select a workspace policy. Signed inbound clients cannot override routing or policy. Routing dry runs validate inputs/references and produce no alerts or deliveries.

## Alert deduplication and receipts

A fingerprint is a bounded literal source identifier, unique for the **entire workspace**, including resolved and suppressed history. Prefix it with a source/service identifier to avoid accidental source collisions. Each accepted new occurrence increments `occurrenceCount` and monotonically advances `lastReceivedAt`; it preserves the original title, policy, incident link, lifecycle and escalation cycle. Repeated resolved or acknowledged fingerprints do not repage. Reopen explicitly to create a new cycle. Fingerprints and operation receipts are retained, not TTL-deleted.

Alert creation, fingerprint receipt, policy snapshot, initial escalation execution, activity and automation outbox event commit together. Stable `operationId` UUID receipts deduplicate retries without increasing occurrence count. Reuse the exact body and operation ID after an ambiguous response; a changed request returns 409. Lifecycle/incident operations have their own durable receipts and confirm previous accepted work before accessing mutable linked targets.

Suppression expires within seven days, cancels future deliveries transactionally, and is resumed by the existing worker. Expiry starts a new cycle using the currently enabled version of the alert's policy. Acknowledgement, resolution and suppression cancel queued/running/dead executions and pending/dead deliveries. Successfully delivered historical pages remain historical. Reopening clears the prior lifecycle timestamps and starts a single new bounded chain; if its policy is no longer active it remains unrouted. Incident declaration and timeline additions use the existing transactional incident service and do not grant incident roles or bypass Sev1 confirmation.

## Delivery and acknowledgement races

The existing worker fairly claims automation events, actions and due escalations with bounded concurrency. Escalation claims use atomic unique owner tokens, a 60-second expiry and fenced writes. Due steps persist the actual admitted recipients and stable per-execution/repeat/step/channel/recipient UUID delivery keys. Private in-app notifications and their succeeded receipts commit in the same transaction; retries skip succeeded delivery receipts.

Dispatch first writes both the leased execution and open alert in its transaction. Acknowledgement writes the same alert and cancels execution/deliveries in its transaction. If acknowledgement commits first, a dispatch cannot pass the open-alert fence and sends nothing. An already admitted bounded webhook dispatch holds that alert write through network completion and transaction commit, so acknowledgement may wait/retry until that dispatch completes. It does not retract an already admitted network request. Webhooks use the existing HTTPS, DNS pinning, signing, encryption and limits from [AUTOMATION.md](AUTOMATION.md); their outbound allowlist must include `escalation.advanced`. Webhook payloads contain only alert ID, severity, correlation and step/repeat indices, with no narrative or private user information.

HTTP effects are **at least once**: remote success followed by transaction rollback, ambiguous commit or a worker crash can repeat the stable delivery ID. Receivers must deduplicate it. MongoDB transaction retry may repeat the admitted HTTP attempt with that same ID. Flowryn does not promise distributed exactly-once delivery. A committed acknowledgement still blocks future admissions. Use synchronized UTC host clocks, MongoDB replica sets, and receiver idempotency. The fixed HTTP deadline is ten seconds, below the transaction and lease window; acknowledgement can wait behind that bounded admission.

Failed retryable deliveries retry with bounded backoff and a five-claim budget per step. Successful deliveries are never automatically resent. Permanent/exhausted deliveries become dead letters; remaining bounded policy steps still run. A terminal execution with any failed delivery remains dead. An admin can retry an eligible failed notification/webhook only while its alert and original cycle are open and its execution is not running/cancelled. A retry preserves stable keys and successful history. Missing-recipient gap records require correcting the schedule/policy and reopening, rather than silently inventing a recipient. No secrets, bodies, raw metadata or stack traces are logged.

## API

Authenticated base: `/api/workspaces/:workspaceId/oncall`. IDs are validated ObjectIds. Pagination: `page` 1–10000, `limit` 1–100 (default 20). Mutations use strict shared Zod schemas. Configuration updates require `{ version, config }`.

| Method   | Path                                                                 | Behavior                                                                                    |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET/POST | `/schedules`, `/policies`, `/routing`                                | List/create configurations                                                                  |
| GET/PUT  | `/schedules/:scheduleId`, `/policies/:policyId`, `/routing/:routeId` | Retrieve/versioned update                                                                   |
| POST     | Configuration `/:id/archive`                                         | Disable/archive; preserve historical snapshots                                              |
| POST     | Configuration `/validate`                                            | Validate structure, permissions and references                                              |
| GET      | `/schedules/:scheduleId/current?at=...`                              | Current layer recipients; `at` optional UTC                                                 |
| GET      | `/schedules/:scheduleId/upcoming?from=...&to=...`                    | Timeline, full gaps and layer gaps (maximum seven days)                                     |
| GET/POST | `/schedules/:scheduleId/overrides`                                   | List/create layer overrides                                                                 |
| POST     | `/schedules/:scheduleId/overrides/:overrideId/cancel`                | Cancel with retained history                                                                |
| GET/PUT  | `/fallback`                                                          | Administrator fallback policy; `{policyId:null}` clears                                     |
| POST     | `/routing/reorder`                                                   | Ordered workspace route IDs; audit and version increments                                   |
| POST     | `/routing/dry-run`                                                   | Valid alert input; returns selected policy/version and route                                |
| GET/POST | `/alerts`                                                            | List/create; creation requires stable operation ID                                          |
| GET      | `/alerts/:alertId`                                                   | Safe alert detail                                                                           |
| POST     | Alert `/acknowledge`, `/resolve`, `/reopen`                          | `{operationId}`                                                                             |
| POST     | Alert `/suppress`                                                    | `{operationId,until}` future UTC, maximum seven days                                        |
| POST     | Alert `/link`                                                        | `{operationId,incidentId}`; null unlinks                                                    |
| POST     | Alert `/declare-incident`                                            | `{operationId,confirmSev1?}`                                                                |
| POST     | Alert `/timeline`                                                    | `{operationId}`; append safe alert description through incident service                     |
| GET      | `/alerts/:alertId/history`                                           | Administrator-only execution and paginated delivery history                                 |
| POST     | `/deliveries/:deliveryId/retry`                                      | Administrator-only eligible dead-letter retry; `{operationId}` confirms ambiguous responses |
| GET      | `/metrics`                                                           | Administrator-only server-calculated operational metrics                                    |

Alert filters: `status`, `severity`, `policyId`, `integrationId`, `incidentId`, UTC `from`/`to` over last received time, and bounded literal title `search` (never a caller-provided regular expression). Configuration lists accept `archived=true`.

Authenticated creation accepts `operationId`, `fingerprint`, `title`, `summary`, `severity`, optional source integration/external event, explicit policy, linked incident, project/service and up to 16 safe labels. Values never become query expressions. Eligible automation uses `alert.create` with configured fingerprint/title/severity and optional policy. It shares the same service and transactional action receipt; repeated occurrences never start competing chains.

Signed inbound `/api/webhooks/:workspaceId/:integrationId` retains Milestone 6 headers, raw-body HMAC verification before parsing, timestamp/replay/rate/size limits and encrypted integration credentials. Version 1 remains the explicit manual-rule incident ingestion contract. Version 2 creates routed alerts:

```json
{
  "schemaVersion": 2,
  "eventType": "alert.received",
  "fingerprint": "service/database/down",
  "title": "Database unavailable",
  "severity": "sev3",
  "labels": { "env": "production" }
}
```

Optional version-2 fields: `summary`, `externalEventId`, `incidentId`, `projectId`, `serviceId`. Only an active integration allowlisting `alert.received` may ingest. Replay delivery IDs are rejected; distinct authenticated deliveries sharing a fingerprint count as occurrences. No inbound actor, policy, roles, status or arbitrary raw source payload is trusted.

## Realtime, metrics and operations

On-call shared event names cover schedules, overrides, alert lifecycle/occurrences, escalation advancement/failures and incident links. Envelopes contain IDs and empty payloads. Safe changes use authorized workspace rooms; pages use private recipient rooms; failures use owner/admin private rooms. The existing Redis adapter, revocation, UUID deduplication, reconnect listener lifecycle and REST invalidations remain in use. Hints are disposable; REST polling is authoritative.

Metrics define open counts from current open alerts; UTC daily alert cohorts over the past 30 days; lifetime duplicate rate `(occurrences-alerts)/occurrences`; lifetime execution count; acknowledgement step counts; private successfully delivered page volume per responder; and current enabled-schedule full gaps over the next 24 hours. Duration means and p50/p95 use full 30-day cohorts, excluding currently suppressed and respective missing timestamps. Reopening clears the old timestamps, so active cycles without acknowledgement/resolution do not contribute durations. MongoDB calculates approximate percentiles without application sampling (MongoDB 7+, local Compose uses 8). Resolution and acknowledgement durations start at the original first receipt. Terminal delivery failure rate is dead/(dead+succeeded), excluding pending/cancelled; corrected retries change final status. Unrouted alerts contribute volume and lifecycle metrics but no executions or pages. Null rates/durations mean no eligible sample.

No new environment variables or real secrets are introduced. The `.env.example` Milestone 6 concurrency/poll/health settings govern all job kinds. Deploy the same version to all API/worker instances, wait for storage indexes, and drain the shared worker on SIGTERM. Start multiple workers against the same database; do not manually clear active lease tokens. An interrupted process is recovered after lease expiry. Inspect history before retrying; acknowledged/resolved/suppressed alerts cannot be repaged via delivery retry. Correct a gap, then explicitly reopen if new paging is intended. Keep encryption-key versions available until stored integrations have been rotated as described in the automation guide. Redis loss can discard realtime hints without losing alerts or pages.
