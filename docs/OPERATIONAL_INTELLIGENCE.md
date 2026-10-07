# Operational intelligence

Flowryn derives a bounded, workspace-scoped priority projection from existing task, incident, alert, reliability, automation, on-call, and status records. Those records remain authoritative. Signals contain identifiers, classifications, short structured facts, immutable score factors, and links; they never copy narratives, comments, runbook text, response content, request headers, subscriber data, secrets, addresses, or stack traces.

## Data and lifecycle

`OperationalSignal` is unique by workspace and stable source key. Reconciliation activates or updates a signal only from a current source revision, resolves missing conditions, and marks overflow stale. Active queues are capped at 2,000 signals per workspace; source reads are individually capped, queues return at most 100 rows, and historical signals expire after 400 days. Recommendations expire after 90 days and use a stable signal/action key. Feedback has a workspace-scoped operation receipt.

The allowlisted conditions are overdue and blocked tasks, active severity-one/two incidents, unacknowledged/escalating alerts, breached/depleted SLOs, repeated monitor failure, automation and monitor dead letters, uncovered schedules, upcoming/overdue maintenance, and ownerless tier-one/two services. Unknown evidence contributes a neutral bounded value and is labelled unknown.

## Scoring and policies

Scores are the rounded sum of five normalized values multiplied by policy weights. The default vector is severity 30, urgency 25, service criticality 20, impact 15, and confidence 10. Each configurable weight is bounded from 0 through 100 and the vector must total 100. Values and contributions are clamped by schemas and the result is clamped to 0–100. Stable ordering is score descending, detection time ascending, then object ID. Dependency influence uses the reliability domain's bounded graph rather than accepting formulas.

The default weights total 100. Policy inputs contain only validated numbers, enums, and bounded arrays. Owners and administrators create immutable versions, then activate or roll back with the version they read and a UUID operation. Members can read the active policy. Existing signal snapshots keep the policy version and complete factors, so activation does not rewrite history.

## Recommendations and authorization

Recommendations are advisory. Accept, dismiss, snooze, complete, and reopen record user feedback idempotently. Every transition verifies active membership through route middleware and rechecks that the signal is active at the exact source revision. Stale items cannot execute. Most actions navigate to the existing source workflow, whose service retains its confirmation, authorization, transaction, and idempotency rules. The only direct quick action is retrying an eligible intelligence evaluation dead letter, restricted to owners/admins and guarded by an atomic state change.

Personal queues require assignment to the authenticated user. Workspace queues, metrics, evaluation history, reconciliation, retry, and policy mutation require an owner/admin. Every query includes `workspaceId`; identifiers are validated before access. Public status routes do not expose intelligence records.

## Worker and recovery

Operational evaluation is a round-robin workload in the existing automation worker. Jobs use atomic claims, 60-second leases, five attempts, deterministic exponential delay, stable work keys, fencing by lease owner, and a dead state. A five-minute bounded reconciliation repairs missed hints with an indexed workspace checkpoint. Source queries, active counts, history, metrics ranges (maximum 90 days), and result sizes are capped. Redis events carry only an empty invalidation envelope; REST is authoritative and reconnect invalidates its caches.

Production uses the existing MongoDB replica set, Redis authorization coordination, and automation worker processes. Monitor worker readiness and intelligence dead-letter counts. Retention and index initialization run through the existing startup storage check.

## API and metrics

Authenticated routes are under `/api/workspaces/:workspaceId/intelligence`: policy active/history/create/activate/rollback; personal and workspace queues/counts; signal and recommendation detail; recommendation feedback and execution; metrics; reconciliation; evaluation history and retry. Metrics use a bounded declaration cohort and report type, severity, service, project, recommendation outcome, repeated condition, evaluation state, and highest-risk projections. Empty cohorts explicitly report insufficient data. Time-to-action and time-to-resolution use feedback and resolved timestamps when present; missing timestamps are excluded rather than treated as zero.

Realtime names are `intelligence.signalCreated`, `signalUpdated`, `signalResolved`, `priorityChanged`, `recommendationCreated`, `recommendationUpdated`, `policyActivated`, and `queueChanged`. They have workspace audiences and empty payloads. Authorization revocation and fail-closed Redis behavior are inherited from the existing gateway.
