# AGENTS.md

## Knowledge base

Project design docs, decisions and the work backlog live in Notion: [Mivra | Project HQ](https://app.notion.com/p/408fb102b9b68185823dc5c90dc17f7f) (reach it through the Notion MCP server).

- Read **Architecture Decisions & Open Questions** first. It is the source of truth for what is decided and what is still open. Accepted so far: ADR-001 (standalone local-first app with a client/server split), ADR-002 (SQLite), ADR-003 (web UI first, Electron later), ADR-004 (Hono server framework), ADR-005 (Node.js, Drizzle, Vercel AI SDK, React + Vite), ADR-006 (learning contract: tool calls, Mivra-owned artifacts, deterministic grading first), ADR-007 (runtime interfaces built alongside features; in-process trusted plugins).
- Treat confirmed decisions as requirements. Treat anything marked proposed as a suggestion, not a requirement.
- Don't mark a decision as accepted, change a major decision, or delete pages unless a human approves it.
- Backlog items live in the **Mivra Work Board** database. When you finish a task, update its item with what changed, how it was tested, and the PR link.
- Code, tests and executable config belong in this repo, not in Notion.

## Development

pnpm monorepo: `packages/server` (Hono, Drizzle + better-sqlite3, Vercel AI SDK), `packages/web` (React + Vite) and `packages/protocol` (shared artifact schemas; the learning contract from ADR-006). New artifact kinds go in `packages/protocol/src/index.ts` (`artifactKinds`); every spec must reject `{}`. See `README.md` for commands. Before finishing a change, run `pnpm typecheck` and `pnpm test`. After editing `packages/server/src/db/schema.ts`, run `pnpm --filter @mivra/server db:generate` and commit the generated migration.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `okhay-p/mivra`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
