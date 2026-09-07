# Flowryn Agent Guide

## Project shape

- `apps/web` is the React/Vite client.
- `apps/api` is the Express API and MongoDB integration boundary.
- `packages/shared` contains runtime-validated contracts and shared constants.

## Local workflow

1. Copy `.env.example` to `.env`.
2. Start infrastructure with `docker compose up -d`.
3. Install with `npm install`.
4. Run `npm run dev` for the web and API together.

Keep business contracts in `packages/shared` so the API and web consume the same source of truth. Prefer small, tested route modules and keep environment access at application boundaries.