# Architecture

Flowryn uses npm workspaces to keep independently deployable applications and reusable contracts in one repository.

```text
apps/web -> packages/shared
apps/api -> packages/shared -> MongoDB / Redis
```

The web application owns presentation and client-side server state through TanStack Query. The API owns HTTP boundaries, authentication, orchestration, and persistence. Shared Zod schemas provide runtime validation at boundaries and inferred TypeScript types for consumers.

MongoDB is the source of truth for durable work data. Redis is reserved for queues, short-lived coordination, and cached projections. Both are provided locally through Docker Compose.