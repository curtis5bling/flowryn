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

## Commands

`npm run build` builds every package. `npm run lint` checks source quality. `npm run typecheck` validates all TypeScript projects. `npm test` runs Vitest. `npm run format:check` verifies formatting.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)