# Flowryn

**Intelligent Work Orchestration**

Turn everyday work into intelligent workflows.

Flowryn is a TypeScript MERN monorepo for turning scattered work into clear, adaptive workflows.

## Getting started

```bash
npm install
copy .env.example .env
docker compose up -d
npm run dev
```

The dashboard runs on `http://localhost:5173`; the API health check is available at `http://localhost:4000/api/health`.

## Identity development

Registration creates a user and routes to explicit workspace onboarding, which creates the first workspace and owner membership. Login, logout, refresh, and current-user requests use secure HTTP-only cookies. Set `JWT_SECRET` in local or deployed environments; the development fallback is intentionally not suitable for production.

Workspace access is tenant-scoped: authenticated requests must have a membership for the requested `workspaceId`, and member-management endpoints require an owner or admin role. Start MongoDB with Docker Compose before running the API or its integration tests.

## Projects and task boards

Inside an authorized workspace, owners and admins manage projects while all members can create and edit tasks. The board supports five statuses, priority and due-date filters, member assignment, task ordering, project activity history, and confirmation for archive/delete actions.

## Real-time collaboration

Authenticated clients receive project changes in workspace rooms, task/comment changes in project rooms, and notifications in private user rooms. Task discussions support paginated comments and author/admin moderation. Notifications track assignments, status changes, comments, and project archival. REST remains the source of truth; reconnecting clients restore room subscriptions and refresh their cached data.

Set `SOCKET_ALLOWED_ORIGINS` to the comma-separated web origins permitted for HTTP and Socket.IO. Production requires a `JWT_SECRET` of at least 32 characters. Access tokens now reference a stored session; users with older tokens must sign in again. Token expiry disconnects sockets, logout revokes the corresponding session, suspension revokes all user sessions, and membership removal/disable evicts workspace and project subscriptions.

Horizontal scaling requires Redis. Set `REALTIME_COORDINATION=redis` and `REDIS_URL` on every API instance, using the same Redis deployment and MongoDB database. The official Socket.IO Redis adapter forwards authorized events; separate publisher and subscriber connections carry validated revocations and coordinate presence. Keep Redis private to this application, with authentication/TLS (`rediss://`) where appropriate. Load balancers must use sticky sessions when HTTP long-polling is enabled. `/api/ready` returns 503 while coordination is unavailable; `/api/health` remains a liveness check.

Local development uses Redis by default with Docker Compose. To run one local API without Redis, explicitly set `NODE_ENV=development` and `REALTIME_COORDINATION=memory`. Tests default to isolated memory coordination and need no external Redis server. Production rejects memory mode and fails startup if Redis is missing or unreachable. The API loads the monorepo `.env`; `DOTENV_CONFIG_PATH` can select a different file.

During a Redis outage, affected instances disconnect sockets, reject new connections/joins, and return 503 for presence and failed authorization propagation. Event delivery is best-effort: REST stays authoritative and clients reload state after reconnect. Connection/subscription health is probed every two seconds; recovery reuses the existing listeners and restores subscriptions. Every five seconds, instances batch unique users, sessions, workspace memberships, and project references into four MongoDB queries. Presence renewal continues independently. Reconciliation never overlaps; three consecutive failed batches or three 15-second unconfirmed intervals disconnect local sockets, while a successful slow cycle resets the failure counter. A database mutation may already have persisted when coordination returns 503; do not treat that response as a rollback.

Presence is deduplicated across tabs/devices using 15-second Redis leases renewed every five seconds. Crashed-process presence expires without cleanup; the web polls every ten seconds to detect that change. Last-seen means the latest Redis-confirmed observation or graceful departure, using the Redis clock; it is null while any device is online. On a crash, it is the last confirmed observation, not an invented disconnect time. Socket IDs, API instance IDs, session identifiers, and tokens are never included in presence responses. SIGINT/SIGTERM closes Socket.IO, removes local leases, and closes both Redis connections.

Revocations use validated operation IDs and explicit account/session/workspace/project scopes. Receivers remove protected rooms synchronously before any database lookup and acknowledge only after eviction completes. The caller waits up to three seconds for acknowledgements from a Redis-leased participant snapshot; a missing acknowledgement returns typed `REVOCATION_INCOMPLETE` (503) and retains local quarantine. Participant leases last 15 seconds; abrupt instance loss can conservatively fail revocation during that window. New instances authenticate against MongoDB before joining rooms. Deploy this protocol to all API instances together; mixed old/new protocol versions are unsupported.

Client recovery tracks transport retries, session refresh, reconnection, and terminal authentication failure separately. An outage does not consume the next authentication cycle?s refresh; successful reconnection rejoins rooms and refreshes REST state.

Account and membership changes must use the Mongoose models (save/update/delete), not raw collection writes or bulk writes, to invoke immediate authorization hooks. Database reconciliation is a backstop for missed messages, not a replacement for those hooks.

## Commands

`npm run build` builds every package. `npm run lint` checks source quality. `npm run typecheck` validates all TypeScript projects. `npm test` runs Vitest. `npm run format:check` verifies formatting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
