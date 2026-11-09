# AGENTS.md

## Knowledge base

Decisions live in `docs/adr/`. When a task touches architecture, the stack or an open question, read `docs/adr/README.md` (the index and what's still open), then only the ADRs that touch the task.

- Treat accepted ADRs as requirements. Treat anything marked proposed as a suggestion, not a requirement.
- Don't mark a decision as accepted, change a major decision, or delete Notion pages unless a human approves it.

Longer design docs and the backlog live in Notion (reach it through the Notion MCP server). Open a design page only when an ADR links to it or the task needs its detail.

- Backlog items live in the [Mivra Work Board](https://app.notion.com/p/16b9fc4073d548139a091ac0691b7e57) database (`collection://66d64521-6e9e-4c15-8a10-713fd2c2b02a`). When you finish a task, update its item with what changed, how it was tested, and the PR link.
- Code, tests, ADRs and executable config belong in this repo, not in Notion.

## Development

pnpm monorepo: `packages/server` (Hono, Drizzle + better-sqlite3, Vercel AI SDK), `packages/web` (React + Vite) `packages/protocol` (shared artifact schemas; the learning contract from ADR-006) and `packages/mivra` (the installable `@okhay-p/mivra` package and its `mivra` CLI, which bundles the others; ADR-013). A new runtime dependency of the server must also go in `packages/mivra/package.json`, or its build fails. A new artifact kind needs a schema in `packages/protocol/src/index.ts` (`artifactKinds`; every spec must reject `{}`) and a registration in a server plugin (`packages/server/src/plugins/`) whose `toView` keeps private fields out. Clients only ever receive artifact views, never raw tool calls. UI uses shadcn/ui on Tailwind v4 (`packages/web/components.json`): add components with `pnpm dlx shadcn@latest add <name>` from `packages/web`, and use theme tokens from `src/styles.css` rather than raw colours. Amber is for the brand only; grading uses `success` and `destructive`. See `docs/development.md` for commands and how the parts work, and `docs/releasing.md` for releases. Before finishing a change, run `pnpm typecheck` and `pnpm test`, plus `pnpm test:e2e` if it touches the UI or the chat flow. After editing `packages/server/src/db/schema.ts`, run `pnpm --filter @mivra/server db:generate` and commit the generated migration.

## Review gate

Every change passes a review gate before its PR is opened. Docs-only changes (Markdown such as `AGENTS.md`, `README.md`, `docs/`) skip it, and need neither the test suites nor review rounds: open the PR directly and say so in its body. Changing an ADR's status or a major decision still needs a human's approval (see above).

1. Request a read-only review from GPT-6.1 Sol through T3 `delegate_task`: `target: { providerInstanceId: <the Codex instance from orchestrator_capabilities>, model: "gpt-6.1-sol", options: { reasoningEffort: "medium" } }`, and check the result echoes that provider, model and option. Give it the change's goal, the diff to inspect, and the checks you ran. Sol must run `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` itself and report the results; this replaces CI, so don't add GitHub Actions for tests. Each e2e run takes a block of ports from `MIVRA_E2E_PORT` (one per worker; see `docs/development.md`), so give a review its own base port. `pnpm test` and the e2e scripts take turns across worktrees (one run at a time by default, `MIVRA_TEST_SLOTS`; see `docs/development.md`), so a run may wait for another to finish first. Ask for a verdict (merge / merge after fixes / don't merge) with findings ranked by severity, and for each finding its likelihood (normal model output, hostile input, or theoretical) and impact. A finding is must-fix only if it's likely in normal use, or if hostile input can cause a hang, a security issue or data loss (uploaded documents are hostile, ADR-010). A theoretical case with cosmetic impact is a nice-to-have.
2. Check each must-fix finding's likelihood yourself before acting on it; real tutor replies are in `~/.mivra/mivra.db` (copy it, never open the live file for writing). Fix every must-fix finding, plus any nice-to-have worth its cost, and tell the owner when you downgrade one. Rerun `pnpm typecheck` and `pnpm test`.
3. Request the next round with a fresh `delegate_task` whose prompt carries the original brief, the prior findings, and what you changed or why you declined.

The gate passes when Sol's verdict is "merge" with no must-fix findings. Stop after 3 rounds; if must-fix findings remain, open the PR anyway and list them unresolved in the PR body. Report Sol's verdict and the round count in the PR body.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `okhay-p/mivra`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `docs/adr/` at the repo root, plus a root `GLOSSARY.md` once a term needs defining. See `docs/agents/domain.md`.
