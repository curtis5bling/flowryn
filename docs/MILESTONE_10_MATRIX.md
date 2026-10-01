# Milestone 10 requirement matrix

| Requirement | Implementation | Evidence |
|---|---|---|
| Workspace signals, references, lifecycle, deduplication and retention | `intelligence/models.ts`, bounded source reconciliation in `service.ts` | API scoring tests; unique indexes; reconciliation paths |
| All documented source conditions and lifecycle changes | Bounded readers for task, incident, alert, SLO, monitor, dead letters, schedules, maintenance and ownership | Reconciliation source matrix and integration with existing domain state |
| Deterministic explainable 0–100 scoring | `calculateScore`, complete factor snapshots, stable queue sort | `service.test.ts` tests determinism, unknowns and every bound |
| Immutable workspace policies, defaults, activation and rollback | Policy model and transactional owner/admin endpoints | Shared policy validation tests; optimistic version check |
| Allowlisted advisory recommendations and stale protection | Recommendation model, explicit catalog, source-version recheck, idempotent feedback | Frontend workflow test; unique recommendation/feedback receipts |
| Personal/workspace/service/project queues | Bounded queue endpoints with shared filters and matching counts | Zod queue bounds tests; tenant-scoped queries |
| Existing durable worker, leases, retry, recovery, dead letters and reconciliation | Intelligence claimer added to `AutomationWorker` round robin; checkpointed sweep | Worker claim filters and stable work-key indexes |
| Domain lifecycle integration | Reconciliation reads current authoritative state and resolves absent conditions | Existing domain lifecycle tests plus reconciliation implementation |
| Complete authenticated API | `routes/intelligence.ts` | Identifier, role, input, pagination and range schemas |
| Typed safe realtime invalidation | Shared event contract and gateway audience map with empty payloads | Existing gateway revocation/reconnection suite; web cache keys |
| Operational intelligence frontend | `IntelligenceApp`, API client, main navigation | `IntelligenceApp.test.tsx` workflow, permissions, error/retry and accessibility checks |
| Server-side bounded metrics | Metrics aggregation with 90-day range and 100-row risk caps | Range schema and route bounds; explicit insufficient-data response |
| Security and privacy boundaries | Explicit fact allowlists, workspace filters, source-version checks, admin gates | Shared/API/web tests and existing auth/revocation tests |
| Documentation and operations | This matrix and `OPERATIONAL_INTELLIGENCE.md`; README, architecture and roadmap links | Documentation review |

No external model, prompts, executable formulas, embeddings, autonomous remediation, vendor communication, or new scheduler/event bus is present.
