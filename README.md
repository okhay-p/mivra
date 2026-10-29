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
cp .env.example .env   # add a provider key and set MIVRA_MODEL
```

`MIVRA_MODEL` is `<provider>:<model-id>`. Providers: `anthropic`, `openai`, and `openrouter` (set `OPENROUTER_API_KEY`, then use any id from [openrouter.ai/models](https://openrouter.ai/models), e.g. `openrouter:<vendor>/<model>`).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server on :4096 with reload, plus Vite on :5173 proxying `/api` to it |
| `pnpm build && pnpm start` | Production: the server serves the built web UI on :4096 |
| `pnpm test` | Server API tests (uses a mock model, no API key needed) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm --filter @mivra/server db:generate` | Generate a migration after editing `src/db/schema.ts` |

Data is stored in `~/.mivra/mivra.db` (override with `MIVRA_DATA_DIR`). The API's OpenAPI document is at `/api/doc`.

## Access and security

- The server and the Vite dev server listen on `127.0.0.1` only.
- Every `/api` request except `/api/health` and `/api/doc` needs `Authorization: Bearer <token>`. The token is created on first start in `~/.mivra/auth-token` (mode 0600). The web UI gets it from a meta tag in `index.html`, injected by the server (production) or Vite (dev).
- The server rejects any `Host` that isn't loopback or listed in `MIVRA_ALLOWED_HOSTS`. This stops DNS-rebinding pages from reading the token.
- To use the UI from another device on your tailnet, proxy it instead of binding all interfaces: `tailscale serve --bg 5173` in dev, or `tailscale serve --bg 4096` plus `MIVRA_ALLOWED_HOSTS=<machine>.ts.net` in production.

For scripts: `curl -H "Authorization: Bearer $(cat ~/.mivra/auth-token)" http://127.0.0.1:4096/api/sessions`.

## Chat turns

Each reply is a *run* (`runs` table). A session has at most one running run, so a second send while a reply streams gets `409`. Message ids are single-use, so a retried request is rejected rather than generating twice. Only completed replies are saved: if the learner stops a reply or disconnects, the model call is aborted and the run is recorded as `cancelled`; provider errors are recorded as `failed` with the error. Runs left running when the server stops are marked `failed` on the next start.
