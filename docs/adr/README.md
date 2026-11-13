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
- [ADR-011](0011-courses-syllabus-and-lessons.md): courses, syllabus and lessons: syllabus up front, lessons just in time, frozen once finished
- [ADR-012](0012-model-picker.md): model picker: one app-wide model and effort chosen in the UI, with run provenance
- [ADR-013](0013-distribution-and-api-keys.md): distribution through npm (main) and Docker; API keys set in the UI or with `mivra auth`, kept out of the database
- [ADR-014](0014-knowledge-graph-and-obsidian-import.md): knowledge graph (notes, links, tags, concept edges) in SQLite, and Obsidian vault import into the global memory
- [ADR-015](0015-sign-in-with-chatgpt.md): sign in with ChatGPT through OpenAI's open-source route, as a provider beside the API keys
- [ADR-016](0016-code-exercises-and-project-courses.md): code exercises in the browser (JavaScript in QuickJS, Python in Pyodide), and project courses checked in the learner's own repo with `mivra check`

## Proposed

- [ADR-017](0017-project-milestones-in-the-syllabus.md): a project course's milestones are its syllabus topics, one per lesson; each `mivra check` replaces the milestone's attempt; it freezes with its lesson

## Project scope

- Name: Mivra.
- Purpose: open-source agent harness specialized for learning.
- Scope: personal learning project rather than commercial SaaS.
- High-level priorities: visualization, context management and memory.
- Branding/domain: no unique standalone domain; planned as a portfolio subdomain.

## Still open

- **Supporting libraries:** pnpm, Tailwind and Vitest are in use. TanStack Router/Query and visualization libraries remain proposals.
- **SQLite operations:** backups beyond the automatic copy made before migrations (ADR-013), and schema versioning.
- **Plugin system:** isolation and permissions beyond ADR-007's in-process trusted plugins.
- **Agent runtime:** single agent + tools vs specialized roles.

## Exploratory (not commitments)

- Optional managed remote-access or hosted tier, possibly paid. No commercial commitment or pricing decision; allocate no work to it.
- Offline multi-device synchronization, a distinct feature from remote access.

## Changing a decision

Agents may add an ADR with `status: proposed`. Only a human approves `status: accepted` or a change to an accepted ADR. Each ADR records its status and date in frontmatter, followed by Context, Options, Decision and Consequences where they add value.
