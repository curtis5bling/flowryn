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

The client uses TanStack Query for project/task server state. Status changes use an optimistic cache update with rollback on failure. The board provides select-based status controls so changing a task never depends on drag-and-drop. No real-time transport is used in this milestone.

MongoDB is the source of truth for durable work data. Redis is reserved for queues, short-lived coordination, and cached projections. Both are provided locally through Docker Compose.