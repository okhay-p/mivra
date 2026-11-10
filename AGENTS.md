# AGENTS.md

## Knowledge base

Decisions live in `docs/adr/`. When a task touches architecture, the stack or an open question, read `docs/adr/README.md` (the index and what's still open), then only the ADRs that touch the task.

- Treat accepted ADRs as requirements. Treat anything marked proposed as a suggestion, not a requirement.
- Don't mark a decision as accepted, change a major decision, or delete Notion pages unless a human approves it.

Longer design docs and the backlog live in Notion (reach it through the Notion MCP server). Open a design page only when an ADR links to it or the task needs its detail.

- Backlog items live in the [Mivra Work Board](https://app.notion.com/p/16b9fc4073d548139a091ac0691b7e57) database (`collection://66d64521-6e9e-4c15-8a10-713fd2c2b02a`). When you finish a task, update its item with what changed, how it was tested, and the PR link.
- Code, tests, ADRs and executable config belong in this repo, not in Notion.

## Development

pnpm monorepo: `packages/server` (Hono, Drizzle + better-sqlite3, Vercel AI SDK), `packages/web` (React + Vite) `packages/protocol` (shared artifact schemas; the learning contract from ADR-006) and `packages/mivra` (the installable `@okhay-p/mivra` package and its `mivra` CLI, which bundles the others; ADR-013). A new runtime dependency of the server must also go in `packages/mivra/package.json`, or its build fails. A new artifact kind needs a schema in `packages/protocol/src/index.ts` (`artifactKinds`; every spec must reject `{}`) and a registration in a server plugin (`packages/server/src/plugins/`) whose `toView` keeps private fields out. Clients only ever receive artifact views, never raw tool calls. UI uses shadcn/ui on Tailwind v4 (`packages/web/components.json`): add components with `pnpm dlx shadcn@latest add <name>` from `packages/web`, and use theme tokens from `src/styles.css` rather than raw colours. Amber is for the brand only; grading uses `success` and `destructive`. See `docs/development.md` for commands and how the parts work, and `docs/releasing.md` for releases. While working, run `pnpm typecheck` and `pnpm test:changed` (only the Vitest tests that import what changed; it misses tests that start code as another process, such as the `mivra` CLI's, see `docs/development.md`), plus the e2e specs for the area you touched if it's the UI or the chat flow (`pnpm --filter @mivra/e2e exec playwright test --project=chromium tests/<spec>`). Don't run the full suites locally: the pull request's `Test` workflow runs them (see below). After editing `packages/server/src/db/schema.ts`, run `pnpm --filter @mivra/server db:generate` and commit the generated migration.

## Review gate

Every change passes a review gate and a green `Test` run before it merges. Docs-only changes (Markdown such as `AGENTS.md`, `README.md`, `docs/`) skip the review: open the PR, say so in its body, and merge once `Test` passes. Changing an ADR's status or a major decision still needs a human's approval (see above).

The review reads the code; GitHub Actions runs the tests. `.github/workflows/test.yml` runs typecheck, build, every package's unit tests and the whole e2e suite (`test:e2e:all`) on each push to a pull request, and its **Tests passed** check must be green to merge. Read failures with `gh pr checks` and `gh run view --log-failed`; a failed e2e job uploads its Playwright traces.

1. Push the branch and open the PR as a draft (`gh pr create --draft`), so `Test` runs while the review does. Then request a read-only review from GPT-6.1 Sol through T3 `delegate_task`: `target: { providerInstanceId: <the Codex instance from orchestrator_capabilities>, model: "gpt-6.1-sol", options: { reasoningEffort: "medium" } }`, and check the result echoes that provider, model and option. Give it the change's goal, the diff to inspect, the commit under review and the checks you ran. Sol reviews the code for logic gaps, unhandled edge cases, missing or weak tests, and departures from the ADRs. It doesn't run the suites. It may run one targeted test, or write a failing one, to confirm a suspected bug before reporting it as must-fix. Ask for a verdict (merge / merge after fixes / don't merge) with findings ranked by severity, and for each finding its likelihood (normal model output, hostile input, or theoretical) and impact. A finding is must-fix only if it's likely in normal use, or if hostile input can cause a hang, a security issue or data loss (uploaded documents are hostile, ADR-010). A theoretical case with cosmetic impact is a nice-to-have.
2. Check each must-fix finding's likelihood yourself before acting on it; real tutor replies are in `~/.mivra/mivra.db` (copy it, never open the live file for writing). Fix every must-fix finding, plus any nice-to-have worth its cost, and tell the owner when you downgrade one. Fix any `Test` failure too. Rerun `pnpm typecheck` and `pnpm test:changed <ref>` from the commit the round reviewed, then push.
3. Request the next round with a fresh `delegate_task` whose prompt carries the original brief, the prior findings, what you changed or why you declined, and the commit the previous round reviewed.

The gate passes when Sol's verdict is "merge" with no must-fix findings and `Test` is green on the PR's head commit. Then mark the PR ready and merge it. Stop after 3 review rounds; if must-fix findings remain, leave them listed unresolved in the PR body for the owner. Never merge on a red or missing `Test` run. Report Sol's verdict and the round count in the PR body.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `okhay-p/mivra`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `docs/adr/` at the repo root, plus a root `GLOSSARY.md` once a term needs defining. See `docs/agents/domain.md`.
