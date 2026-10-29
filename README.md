# Mivra

An open-source, local-first AI agent harness for learning. Design docs and decisions live in the [Mivra Project HQ](https://app.notion.com/p/408fb102b9b68185823dc5c90dc17f7f) Notion space.

## Layout

| Package | What it is |
|---|---|
| `packages/server` | Hono API server (Node.js). Owns the agent runtime, the SQLite database (Drizzle + better-sqlite3) and model access (Vercel AI SDK). Binds to `127.0.0.1` only. |
| `packages/web` | React + Vite web UI. Talks to the server only through its API. |

## Setup

Requires Node.js 22.12+ and pnpm 10 (`npm i -g pnpm`, or prefix commands with `npx pnpm@10`).

```sh
pnpm install
cp .env.example .env   # add ANTHROPIC_API_KEY or OPENAI_API_KEY
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server on :4096 with reload, plus Vite on :5173 proxying `/api` to it |
| `pnpm build && pnpm start` | Production: the server serves the built web UI on :4096 |
| `pnpm test` | Server API tests (uses a mock model, no API key needed) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm --filter @mivra/server db:generate` | Generate a migration after editing `src/db/schema.ts` |

Data is stored in `~/.mivra/mivra.db` (override with `MIVRA_DATA_DIR`). The API's OpenAPI document is at `/api/doc`.
