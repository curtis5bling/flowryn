# Roadmap

## Foundation

- [x] Monorepo, shared contracts, API health endpoint, and dashboard shell
- [x] Local MongoDB and Redis services
- [x] TypeScript, ESLint, Prettier, and Vitest
- [x] Identity, rotating cookie sessions, workspaces, membership roles, and tenant authorization
- [x] Projects, task boards, filtering, ordering, assignment, and activity tracking

## Next

- [x] Real-time collaboration, task comments, private notifications, and reconnect recovery
- [x] Session-bound socket authentication, expiration, and model-driven authorization revocation
- [x] Redis-backed cross-process presence and revocation delivery
- [x] Fail-closed Redis outages, readiness, recovery, graceful shutdown, and simulated cluster regression tests

## Milestone 5: Incident management

- [x] Workspace incidents, concurrent-safe numbering, explicit lifecycle and resolution/reopen workflows
- [x] Transactional append-only timelines, activity, idempotent commands and private notifications
- [x] Active-member response assignments, tenant-safe links and administrative archive controls
- [x] Runbook source management, stable steps, immutable incident snapshots and isolated progress
- [x] Authorized incident rooms, reconnect recovery and Redis lease-based collaborator presence
- [x] Accessible incident dashboard, command center, declaration, runbook editing and UTC metrics
- [x] Replica-set integration tests for concurrency, rollback, authorization, history and live isolation
- [x] Frontend declaration, resolution, runbook ordering and reconnect tests

## Milestone 6: Workflow automation and integrations

- [x] Versioned structured rules and controlled workspace actions
- [x] MongoDB transactional outbox, leased workers and action-level execution history
- [x] Idempotent effects, causal loop prevention, retry and dead-letter controls
- [x] Encrypted generic integrations, signed alert ingestion and protected outbound webhooks
- [x] Automation management interface, private realtime hints and server-side metrics
- [x] Replica-set automation regressions and mocked network security tests

## Milestone 7: On-call scheduling, alert routing and escalation

- [x] Workspace schedules, ordered layers, UTC rotations and IANA-local DST coverage
- [x] Audited deterministic overrides, opt-in self-override permissions and retained history
- [x] Versioned bounded escalation policies and allowlisted routing with fallback/dry-run
- [x] Atomic fingerprint/operation deduplication, alert lifecycle and incident-service integration
- [x] Shared durable worker, multi-process lease fencing, acknowledgement arbitration and delivery receipts
- [x] Private in-app pages, approved signed webhooks and eligible dead-letter retries
- [x] Accessible On-Call interface, explicit realtime audiences and server-side metrics
- [x] Replica-set concurrency/race, DST, authorization, delivery and frontend regression coverage

## Later

- [ ] Intelligent prioritization and suggested next actions
- [ ] Integrations for calendar, email, chat, and project tools
- [ ] Audit logs, usage analytics, and production observability

Public status pages, vendor-specific paging providers and AI incident automation remain deferred.
