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

Inside an authorized workspace, owners and admins manage projects while all members can create and edit tasks. The board supports five statuses, priority and due-date filters, member assignment, task ordering, project activity history, and confirmation for archive/delete actions. Task mutations and activity feeds remain workspace-scoped; real-time updates are intentionally deferred.

## Commands

`npm run build` builds every package. `npm run lint` checks source quality. `npm run typecheck` validates all TypeScript projects. `npm test` runs Vitest. `npm run format:check` verifies formatting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)