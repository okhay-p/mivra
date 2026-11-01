# Architecture decisions

The source of truth for what is decided and what is still open. If another doc conflicts with this folder, this folder wins. Read this index, then only the ADRs that touch your task.

Files use four digits (`0010-*.md`); the code cites them as `ADR-010`. The next number is one above the highest here.

## Accepted

- [ADR-001](0001-standalone-local-first-client-server.md): standalone local-first app with a client/server split
- [ADR-002](0002-sqlite-local-storage.md): SQLite for local storage
- [ADR-003](0003-web-ui-first-desktop-later.md): web UI first, Electron later
- [ADR-004](0004-hono-server-framework.md): Hono server framework, SSE for agent output
- [ADR-005](0005-core-stack.md): Node.js, Drizzle, better-sqlite3, Vercel AI SDK, React + Vite
- [ADR-006](0006-learning-contract.md): learning contract: tool calls, Mivra-owned artifacts, deterministic grading first
- [ADR-007](0007-runtime-interfaces-and-plugin-trust.md): runtime interfaces built alongside features; in-process trusted plugins
- [ADR-008](0008-shadcn-paper-and-amber.md): web UI: shadcn/ui with the Paper & Amber theme
- [ADR-009](0009-learner-memory.md): learner memory: evidence, derived concept state, automatic global memories
- [ADR-010](0010-uploaded-documents-local-text-extraction.md): uploaded documents: local text extraction

## Project scope

- Name: Mivra.
- Purpose: open-source agent harness specialized for learning.
- Scope: personal learning project rather than commercial SaaS.
- High-level priorities: visualization, context management and memory.
- Branding/domain: no unique standalone domain; planned as a portfolio subdomain.

## Still open

- **Supporting libraries:** pnpm, Tailwind and Vitest are in use. TanStack Router/Query and visualization libraries remain proposals on [Foundation — Tech Stack & Deployment](https://app.notion.com/p/408fb102b9b6811b9f1ffc20fb46c928) (Notion).
- **SQLite operations:** backup approach and schema versioning. See [Foundation — Local-First Storage & Cloud Sync](https://app.notion.com/p/408fb102b9b681c5b636d60cdfd891d7) (Notion).
- **Plugin system:** isolation and permissions beyond ADR-007's in-process trusted plugins. See [Foundation — Extension & Plugin API Research](https://app.notion.com/p/408fb102b9b681138484e219ea70934d) (Notion).
- **Agent runtime:** single agent + tools vs specialized roles.
- **Learning:** the definition of learning success.

## Exploratory (not commitments)

- Optional managed remote-access or hosted tier, possibly paid. No commercial commitment or pricing decision; allocate no work to it.
- Offline multi-device synchronization, a distinct feature from remote access.

## Changing a decision

Agents may add an ADR with `status: proposed`. Only a human approves `status: accepted` or a change to an accepted ADR. Each ADR records its status and date in frontmatter, followed by Context, Options, Decision and Consequences where they add value.
