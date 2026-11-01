---
status: accepted
date: 29 October 2026
---

# ADR-005: Core stack — Node.js, Drizzle, Vercel AI SDK, React + Vite

**Context:** Completes the stack around ADR-002 (SQLite), ADR-003 (web first, Electron later) and ADR-004 (Hono).

**Decision:** Runtime: Node.js (LTS) — chosen for compatibility, since Electron runs Node; Bun is nicer to use but considered not stable enough yet. Database access and migrations: Drizzle. LLM layer: Vercel AI SDK (switching model providers, tool calls, streaming). Web UI: React + Vite.

**Consequences:** One runtime from development through Electron. Drizzle can switch SQLite drivers later without rewriting queries.

**SQLite driver (added 29 October 2026):** better-sqlite3 under Drizzle — mature and fast; needs a native rebuild for Electron (@electron/rebuild). node:sqlite can replace it later through Drizzle once stable, without changing queries.

**Still open:** supporting libraries (pnpm workspaces, TanStack Router/Query, Tailwind, visualization libraries, Vitest) remain proposals on [Foundation — Tech Stack & Deployment](https://app.notion.com/p/408fb102b9b6811b9f1ffc20fb46c928) (Notion).
