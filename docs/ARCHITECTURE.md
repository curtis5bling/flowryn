# Architecture

Flowryn uses npm workspaces to keep independently deployable applications and reusable contracts in one repository.

```text
apps/web -> packages/shared
apps/api -> packages/shared -> MongoDB / Redis
```

The web application owns presentation and client-side server state through TanStack Query. The API owns HTTP boundaries, authentication, orchestration, and persistence. Shared Zod schemas provide runtime validation at boundaries and inferred TypeScript types for consumers.

## Identity and workspaces

Users authenticate with bcrypt-hashed passwords. Registration is followed by explicit workspace onboarding, which creates the first workspace and owner membership. Access tokens are short-lived and held in an HTTP-only cookie; refresh tokens are also HTTP-only, persisted as hashes in `AuthSession`, rotated on every refresh, and revoked on logout. Production cookies use `secure` and `sameSite=lax`.

`User`, `Workspace`, `WorkspaceMember`, and `AuthSession` are API-owned Mongoose models. Every workspace request first authenticates the user, then looks up membership by both `workspaceId` and `userId`. Role middleware limits administrative operations to `owner` and `admin`, while read access accepts all three roles. No route trusts a workspace identifier without this membership query, providing the tenant-isolation boundary for future workstream data.

The web client treats `/api/auth/me` as the session source of truth and sends credentials with every API request. Unauthenticated users see login/registration; authenticated users see the protected dashboard and can create an additional workspace during onboarding.

## Projects, tasks, and activity

Projects, tasks, and activities are always stored with `workspaceId`. Project writes require an owner or admin membership. Task creation and editing are available to all workspace members, while destructive task deletion is restricted to owners and admins. Assignees are accepted only when an active membership exists in the same workspace.

Project and task route queries include both the workspace scope and the resource identifier. Project task lists support validated status, priority, assignee, due-date, pagination, and sorting filters. Moving and reordering tasks update the board fields directly and emit safe activity records containing only IDs, names, statuses, priorities, and positions.

The client uses TanStack Query for project/task server state. Status changes use an optimistic cache update with rollback on failure. Incoming events do not refetch task data during pending mutations. The board provides select-based status controls so changing a task never depends on drag-and-drop.

## Collaboration boundaries

Socket.IO shares the Express HTTP server. Handshakes verify the access token signature, finite expiration, active user, and unrevoked stored session. Every client request uses a shared Zod payload schema and a sanitized acknowledgement. Room joins recheck authorization; a mutation revision rejects joins overlapping revocation. Token deadlines disconnect sockets and their timers are cleared on disconnect.

Mongoose save and query update/delete hooks determine revocation at the origin, then await local enforcement and acknowledgements from a Redis-leased participant snapshot. Remote receivers do not query MongoDB before enforcement. Suspension invalidates stored sessions and disconnects sockets across instances; removed or disabled memberships evict workspace-qualified rooms on every instance. Logout and refresh rotation disconnect the revoked session. The internal control channel contains only a UUID event ID and a strict discriminated payload: kind/userId, plus workspaceId for membership or tokenId for session revocation. Requests include source instance and operation UUIDs; acknowledgements contain only operation and responding instance UUIDs. Receivers validate and deduplicate enforcement, immediately quarantine and remove workspace/project/scoped notification rooms, then acknowledge completed removal. Duplicate requests can repeat acknowledgements but cannot release another concurrent operation?s quarantine. Three-second acknowledgement timeout returns typed REVOCATION_INCOMPLETE; failed operations retain local quarantine. Participant registry leases use Redis TIME, renew on health probes, and expire after 15 seconds. Use a coordinated deployment: older processes do not participate in this protocol. Raw database writes and bulk writes bypass immediate hooks and are not supported for authorization mutations.

Event audiences are explicit: project lifecycle events go to workspace rooms, task/comment events to workspace-qualified project rooms, and notification envelopes exclusively to the recipient's workspace- or project-scoped user room. Durable events include UUIDs and timestamps. Comments and notifications carry workspace IDs; comment mutation permissions require authorship or an owner/admin role, and notification queries also constrain the authenticated recipient and active membership.

The frontend attaches one stable connect listener per socket lifecycle, restores subscriptions after reconnect, invalidates REST-backed queries to recover missed changes, deduplicates event IDs, and removes every listener during cleanup. Presence refreshes on events and every ten seconds so expired process leases are reflected even without a disconnect event.

## Redis coordination and failure handling

The official `@socket.io/redis-adapter` uses independent ioredis publisher/subscriber connections configured by `REDIS_URL`. Adapter commands that intentionally ignore promises are wrapped to contain errors and mark coordination unavailable; application control-plane commands still reject. A two-second probe confirms both connections and delivery on the control subscription. Adapter subscription commands are tracked and restored during probes without adding duplicate listeners. Redis is trusted internal infrastructure; use application-isolated credentials/channels and sticky load-balancer sessions for polling transports.

Presence is a workspace-scoped sorted set of internal user/instance leases. Lua scripts use Redis TIME to atomically update leases and monotonically increasing last-seen records. Leases live 15 seconds and renew every five seconds, with expired entries pruned on reads. A separate workspace last-seen set expires after 30 days without workspace presence activity. Public responses contain only active workspace members, names, online flags, and timestamps; no transport metadata. Redis responses and outgoing presence entries are validated before use. Last-seen is the last confirmed observation/departure and is null for online members.

Redis Pub/Sub is not durable. A disconnected or unhealthy instance immediately drops its sockets, blocks handshakes/joins and presence reads, and fails readiness. Instances snapshot sockets and reconcile unique users, sessions, memberships and project references with four concurrent batched queries every five seconds. Presence renewal and Redis readiness are independent. A running reconciliation never overlaps another; three consecutive query failures or three 15-second unconfirmed intervals fail closed. Slow successful cycles reset this counter, and token deadlines remain independently enforced. Propagation failure is explicit (503), even when the database mutation has already persisted. Recovery requires a successful Pub/Sub probe; new sockets must authenticate and authorize again. REST recovers missed application events. Logs contain fixed structured event names and never Redis URLs, credentials, tokens, or raw exceptions.

Tests use the same coordination abstraction with a lease-aware simulated network and mocked Redis clients. Two independent gateways verify that remote enforcement works without sharing the local mutation bus. Production requires Redis; only tests and explicitly configured single-instance development may use memory. Graceful shutdown closes Socket.IO, removes local presence, closes both Redis connections, and clears timers/listeners; leases cover abrupt process failure.

MongoDB is the source of truth for durable work data. Redis provides short-lived coordination and Socket.IO routing. Both are provided locally through Docker Compose.
