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

Presence and revocation delivery currently run within one API process and support multiple tabs. Run a single API instance; the configured Redis service is not yet used for shared presence or cross-process socket revocation. Account and membership changes must use the Mongoose models (save/update/delete), not raw collection writes or bulk writes, to invoke the awaited authorization hooks.

## Commands

`npm run build` builds every package. `npm run lint` checks source quality. `npm run typecheck` validates all TypeScript projects. `npm test` runs Vitest. `npm run format:check` verifies formatting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
