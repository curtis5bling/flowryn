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

Registration creates a user, a personal workspace, and an owner membership. Login, logout, refresh, and current-user requests use secure HTTP-only cookies. Set `JWT_SECRET` in local or deployed environments; the development fallback is intentionally not suitable for production.

Workspace access is tenant-scoped: authenticated requests must have a membership for the requested `workspaceId`, and member-management endpoints require an owner or admin role. Start MongoDB with Docker Compose before running the API or its integration tests.

## Commands

`npm run build` builds every package. `npm run lint` checks source quality. `npm run typecheck` validates all TypeScript projects. `npm test` runs Vitest. `npm run format:check` verifies formatting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)