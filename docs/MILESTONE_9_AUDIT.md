# Milestone 9 requirement audit

This matrix maps the Milestone 9 specification to the implementation. It is maintained with the feature and is independent of build status.

| Area | Implementation and invariants |
| --- | --- |
| Catalog | `ServiceModel` and reliability routes provide bounded workspace records, active-member owners, project validation, safe links, unique normalized slugs, lifecycle/version changes, archive cascades, and owner/admin mutation. |
| Dependencies | Unique workspace edges are serialized by a graph lock, reject self/cross-workspace edges and cycles, retain archived history, and expose bounded ten-level/500-node impact traversal plus a table UI. |
| Relationships | Typed service relationships validate workspace targets for components, incidents, alerts, policies, and projects. They do not invoke publication or public-status mutation. |
| SLOs and SLI | Immutable SLO versions support availability, error-rate, and latency. API, signed webhook, synthetic, and automation sources are explicitly bound. Batches, metadata, timestamps, retention, and idempotency are bounded. |
| Evaluation and alerts | Server aggregation stores immutable SLO/version/window snapshots, explicit unknown state, compliance, budget, deterministic short/long burn windows, breach transitions, stable alert fingerprints, approved policy references, recovery resolution, and transactional automation events. |
| Synthetic monitoring | HTTPS-only GET/HEAD checks use DNS validation, IP pinning, redirect revalidation, response/time limits, encrypted write-only headers, stable schedule IDs, atomic monitor leases, execution leases, bounded retries, dead letters, and administrative retry. Endpoint health and infrastructure failure are separate. |
| Automation | Typed SLO/monitor triggers use the existing transactional outbox and chain/loop fences. `sli.ingest` is an explicit bounded action whose operation ID becomes the sample idempotency key. |
| Realtime | Typed catalog, SLO, and monitor events preserve existing workspace authorization and Redis reconnection. Detailed `monitor.failed` events use the existing private admin relay; payloads contain no request, response, DNS, secret, or stack data. REST remains authoritative. |
| Metrics | The API returns lifecycle/criticality, owner coverage, current compliance/budgets, monitor health and bounded reliability aggregates. Unknown samples are excluded from healthy counts and retention/range limits are documented. |
| Frontend | The Reliability section provides catalog, dependency table, objectives/budgets, monitor configuration, warning and health states, loading/empty/error/offline semantics. Secrets are write-only. |
| Security | Workspace filters precede reads and writes; identifiers and references are validated; signed input is verified over raw bytes with timestamp tolerance and constant-time HMAC; replay/rate/body/batch limits apply; monitor networking denies private and rebinding destinations. |
| Tests | Contract, URL/SSRF, deterministic scheduling, automation transport, authorization, worker, realtime, and UI suites use mocks and local adapters only. No reliability test makes a real network call. |
| Documentation | `RELIABILITY.md`, architecture, roadmap, README, and this audit describe contracts, arithmetic, security, retention, recovery, deployment, and exclusions. |

The implementation intentionally excludes PromQL, scripts, browser/ICMP monitoring, agents, vendor-specific ingestion, AI remediation, SMS, and telephone delivery.
