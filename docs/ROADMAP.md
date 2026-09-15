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

## Next automation milestones

- [ ] Workflow builder with trigger, condition, and action nodes
- [ ] Redis-backed job execution and activity history

## Later

- [ ] Intelligent prioritization and suggested next actions
- [ ] Integrations for calendar, email, chat, and project tools
- [ ] Audit logs, usage analytics, and production observability

External monitoring ingestion, on-call scheduling, public status pages and AI incident automation are deferred beyond Milestone 5.
