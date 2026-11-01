# AGENTS.md

## Knowledge base

Project design docs, decisions and the work backlog live in Notion: [Mivra | Project HQ](https://app.notion.com/p/408fb102b9b68185823dc5c90dc17f7f) (reach it through the Notion MCP server).

- Read **Architecture Decisions & Open Questions** first. It is the source of truth for what is decided and what is still open. Accepted so far: ADR-001 (standalone local-first app with a client/server split), ADR-002 (SQLite), ADR-003 (web UI first, Electron later), ADR-004 (Hono server framework), ADR-005 (Node.js, Drizzle, Vercel AI SDK, React + Vite), ADR-006 (learning contract: tool calls, Mivra-owned artifacts, deterministic grading first), ADR-007 (runtime interfaces built alongside features; in-process trusted plugins), ADR-008 (web UI: shadcn/ui with the Paper & Amber theme), ADR-009 (learner memory: evidence, derived concept state, automatic global memories), ADR-010 (uploaded documents: local text extraction).
- Treat confirmed decisions as requirements. Treat anything marked proposed as a suggestion, not a requirement.
- Don't mark a decision as accepted, change a major decision, or delete pages unless a human approves it.
- Backlog items live in the **Mivra Work Board** database. When you finish a task, update its item with what changed, how it was tested, and the PR link.
- Code, tests and executable config belong in this repo, not in Notion.

## Development

pnpm monorepo: `packages/server` (Hono, Drizzle + better-sqlite3, Vercel AI SDK), `packages/web` (React + Vite) and `packages/protocol` (shared artifact schemas; the learning contract from ADR-006). A new artifact kind needs a schema in `packages/protocol/src/index.ts` (`artifactKinds`; every spec must reject `{}`) and a registration in a server plugin (`packages/server/src/plugins/`) whose `toView` keeps private fields out. Clients only ever receive artifact views, never raw tool calls. UI uses shadcn/ui on Tailwind v4 (`packages/web/components.json`): add components with `pnpm dlx shadcn@latest add <name>` from `packages/web`, and use theme tokens from `src/styles.css` rather than raw colours. Amber is for the brand only; grading uses `success` and `destructive`. See `README.md` for commands. Before finishing a change, run `pnpm typecheck` and `pnpm test`, plus `pnpm test:e2e` if it touches the UI or the chat flow. Run `pnpm test:e2e:all` for graph, layout, font or keyboard changes. After editing `packages/server/src/db/schema.ts`, run `pnpm --filter @mivra/server db:generate` and commit the generated migration.

## Review gate

Every change passes a review gate before its PR is opened:

1. Request a read-only review from GPT-6.1 Sol through T3 `delegate_task`: `target: { providerInstanceId: <the Codex instance from orchestrator_capabilities>, model: "gpt-6.1-sol", options: { reasoningEffort: "medium" } }`, and check the result echoes that provider, model and option. Give it the change's goal, the diff to inspect, and the checks you ran. Sol must run `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` itself and report the results; this replaces CI, so don't add GitHub Actions for tests. Ask for a verdict (merge / merge after fixes / don't merge) with findings ranked by severity.
2. Fix every must-fix finding, plus any nice-to-have worth its cost. Rerun `pnpm typecheck` and `pnpm test`.
3. Request the next round with a fresh `delegate_task` whose prompt carries the original brief, the prior findings, and what you changed or why you declined.

The gate passes when Sol's verdict is "merge" with no must-fix findings. Stop after 3 rounds; if must-fix findings remain, open the PR anyway and list them unresolved in the PR body. Report Sol's verdict and the round count in the PR body.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `okhay-p/mivra`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
