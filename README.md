# Mivra

An open-source, local-first AI agent harness for learning. Design docs and decisions live in the [Mivra Project HQ](https://app.notion.com/p/408fb102b9b68185823dc5c90dc17f7f) Notion space.

## Layout

| Package | What it is |
|---|---|
| `packages/server` | Hono API server (Node.js). Owns the agent runtime, the SQLite database (Drizzle + better-sqlite3) and model access (Vercel AI SDK). Binds to `127.0.0.1` only. |
| `packages/web` | React + Vite web UI (shadcn/ui on Tailwind v4). Talks to the server only through its API. |
| `packages/protocol` | Versioned Zod schemas for learning artifacts (`algorithm_trace`, `multiple_choice`), their tool definitions and the deterministic grader. Shared by server and web. |

## Setup

Requires Node.js 22.12+ and pnpm 10 (`npm i -g pnpm`, or prefix commands with `npx pnpm@10`).

```sh
pnpm install
cp .env.example .env   # add a provider key and set MIVRA_MODEL
```

`MIVRA_MODEL` is `<provider>:<model-id>`. Providers: `anthropic`, `openai`, and `openrouter` (set `OPENROUTER_API_KEY`, then use an id from [openrouter.ai/models](https://openrouter.ai/models), e.g. `openrouter:<vendor>/<model>`). Mivra's learning tools need tool calling, so pick a model that lists tool support; many free models don't.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server on :4096 with reload, plus Vite on :5173 proxying `/api` to it |
| `pnpm build && pnpm start` | Production: the server serves the built web UI on :4096 |
| `pnpm test` | Protocol, server API (mock model, no API key needed) and web component tests (Vitest + jsdom) |
| `pnpm test:e2e` | Browser tests (Playwright): the built UI and real server with a scripted model, so no API key is needed. Run `pnpm --filter @mivra/e2e exec playwright install chromium` once first |
| `pnpm typecheck` | Type-check all packages |
| `pnpm --filter @mivra/server db:generate` | Generate a migration after editing `src/db/schema.ts` |

Workspace packages resolve to their TypeScript source in dev, tests and type-checking through the `@mivra/source` export condition, so `pnpm dev` needs no prebuild. `pnpm build` compiles `packages/protocol` first; the production server loads its `dist`.

Data is stored in `~/.mivra/mivra.db` (override with `MIVRA_DATA_DIR`). The API's OpenAPI document is at `/api/doc`.

## Learner memory

Each turn's instructions include part of the learner's record across all sessions: up to 30 recently practised concepts, each with how many checks were answered, how many were right, and the latest result. It is calculated from the latest 1000 graded attempts and never stored separately, so older practice stops counting (ADR-009).

The model can also save goals, preferences and misconceptions with the `remember` tool. They save automatically, take effect only if the reply completes, and appear in the sidebar's Memory panel, where the learner can edit or permanently delete them. A misconception is linked to a graded wrong answer on the same concept when there is one, and otherwise counts as only an impression from chat. A memory written while a check in its session is unanswered could give the answer away, so until the check is answered its content is hidden from the panel and left out of other turns, though it can still be deleted. One reply can save at most 5 memories, and the newest 40 are included in each turn. What was said in the chat itself stays in that session's conversation, so deleting a memory doesn't remove it from there.

## Web UI

The UI uses [shadcn/ui](https://ui.shadcn.com) with the Paper & Amber theme (ADR-008). Components are copied into `packages/web/src/components/ui`, and theme tokens live in `src/styles.css`. To add a component, run `pnpm dlx shadcn@latest add <name>` from `packages/web`, then check that it didn't overwrite the tokens in `styles.css`, and point any `from "cn"` import at `@/lib/utils`. Fonts are bundled through `@fontsource`, so the app needs no network for them. The theme follows the OS until the learner picks Light or Dark in the sidebar; the choice is saved in the browser.

## Access and security

- The server and the Vite dev server listen on `127.0.0.1` only.
- Every `/api` request except `/api/health` and `/api/doc` needs `Authorization: Bearer <token>`. The token is created on first start in `~/.mivra/auth-token` (mode 0600). The web UI gets it from a meta tag in `index.html`, injected by the server (production) or Vite (dev).
- The server rejects any `Host` that isn't loopback or listed in `MIVRA_ALLOWED_HOSTS`. This stops DNS-rebinding pages from reading the token.
- To use the UI from another device on your tailnet, proxy it instead of binding all interfaces: `tailscale serve --bg 5173` in dev, or `tailscale serve --bg 4096` plus `MIVRA_ALLOWED_HOSTS=<machine>.ts.net` in production.

For scripts: `curl -H "Authorization: Bearer $(cat ~/.mivra/auth-token)" http://127.0.0.1:4096/api/sessions`.

## Chat turns

Each reply is a *run* (`runs` table). A session has at most one running run, so a second send while a reply streams gets `409`. Message ids are single-use, so a retried request is rejected rather than generating twice. Only completed replies are saved: if the learner stops a reply or disconnects, the model call is aborted and the run is recorded as `cancelled`; provider errors are recorded as `failed` with the error. Runs left running when the server stops are marked `failed` on the next start.

## Learning artifacts

The agent shows interactive artifacts through tool calls (ADR-006): `show_algorithm_trace` and `ask_multiple_choice`, registered by the first-party `core-learning` plugin (`packages/server/src/plugins/`) through the capability registry (ADR-007).

- Each tool call's input is validated against its `packages/protocol` schema and stored in `artifacts` with the full spec. Client output fails closed: the live stream and `GET /api/sessions/{id}/messages` pass only text and lifecycle parts plus `data-artifact` parts with the artifact's public view. Raw tool calls, model reasoning, sources and files never reach a client, so a check's answer key, explanation and feedback stay on the server.
- `POST /api/artifacts/{id}/attempts` with `{ "answer": { "optionIndex": n } }` grades a check deterministically and returns the view with the grade. One attempt per check, accepted once the reply that asked it has finished.
- On later turns, each check's tool result tells the model whether the learner answered and how they did.
- The web UI renders `data-artifact` parts by kind (`packages/web/src/artifacts/`). Each part is validated against the protocol's `ArtifactView` first; anything that fails shows a "can't display this item" placeholder. A trace is a stepper (prev/next, play/pause, arrow keys). A check posts the learner's choice and then shows the grade. Its options stay disabled while the reply that contains it is still streaming, and once it has been answered.

