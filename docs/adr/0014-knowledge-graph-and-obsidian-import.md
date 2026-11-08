---
status: proposed
date: 8 November 2026
---

# ADR-014: Knowledge graph and Obsidian vault import

**Context:** Memory (ADR-009) is a flat list of goals, preferences and misconceptions, plus concept state derived from graded answers. It can't show how concepts relate, and a new learner starts from nothing even when they already keep notes elsewhere. Learners want an Obsidian-like view of what Mivra knows, linked notes and a graph, and want to bring an existing Obsidian vault so Mivra knows what they already know. Vaults are loosely structured: scattered notes, inconsistent tags, many notes that never link to anything.

**Options:**

- **Store:** (A) a folder of Markdown files as the source of truth; (B) SQLite as the source of truth, with Markdown as the note format inside it and export to a vault.
- **Import target:** (A) a separate knowledge source the learner switches on and off; (B) feeding the one global memory.
- **Imported memories:** (A) a bulk keep/discard review; (B) saved automatically like other memories.

**Decision:** (B) for all three.

- **SQLite stays the source of truth (ADR-002).** Files can't keep a held memory hidden, can't guarantee the server-set source, basis and supersession, and would need a watcher and conflict handling once edited outside Mivra. Learners read the graph and notes; they don't write notes. The server and the model write them, and the memory panel keeps ADR-009's edit and delete.
- **Three layers.**
  - *Imported notes*: the vault as it is, written only by the import. Loose structure is fine here.
  - *Concepts and edges*: graph nodes, keyed by the existing `conceptKey`. Edges are `prerequisite` or `related`, written by the model through a validated tool.
  - *Memories*: as in ADR-009.

  Note bodies are Markdown. On save, the server parses `[[wiki-links]]` and `#tags` into link and tag tables. A link to a note that doesn't exist is kept as an unresolved node.
- **Prior knowledge is a claim, not evidence.** A new memory kind, `known`, with the new basis `import`, records that the learner's notes cover a concept. It is shown to the model separately from concept state and ranked below it. A graded answer always outranks a note, so a wrong answer on a "known" concept is evidence of a gap, not a contradiction.
- **Import runs in stages:**
  1. *Parse, without a model.* Read frontmatter, links, tags, headings and folder paths, and split long notes by heading. This gives a graph and search even for messy vaults, and the same vault always gives the same result.
  2. *Index.* Put the chunks in FTS5 (ADR-009) and the links and tags in the edge tables. The context builder can then pull matching chunks and their linked neighbours, as data rather than instructions (ADR-010).
  3. *Distil, in the background with the model.* The model reads clusters of notes (grouped by links, tags or folder) and proposes concepts, matched to existing names so variants collapse. It also proposes concept edges and memories (`known`, plus goals or misconceptions stated in the notes). Each one keeps a link to its source note. These save automatically. Notes that never map to a concept stay searchable but don't become graph nodes.
- **A vault is hostile input (ADR-010).** Cap the file count and total size. Import only `.md` files. Skip `.obsidian/`, attachments and plugin config. Dataview queries and embeds stay plain text, never executed.
- **Re-import is a snapshot, not a sync.** Files are keyed by vault path and content hash. Importing again updates changed files, adds new ones, and removes deleted ones from that import. Deleting an import removes its notes and the memories drawn from it.
- **Entry points.** All three end in the same server import, so the server alone writes the database (ADR-002).
  - *CLI:* `mivra import obsidian <folder>`, where the folder is the vault root; any folder of `.md` files works. It reads files on the machine it runs on and sends them to the running server with the local API token, so with Docker the vault must be mounted into the container.
  - *Web UI, main option:* a folder picker (`<input webkitdirectory>`). The page sends only `.md` files, so attachments never upload. This works over Tailscale through the existing host allow-list and token (ADR-013).
  - *Web UI, fallback:* a zip upload, for browsers that can't pick folders, such as on iOS. The server caps the compressed size, the total unzipped size and the entry count, so a zip bomb can't exhaust memory. It reads entries in memory and never writes them to disk by their stored paths, which rules out path traversal and symlinks. It unzips in a child process, as document extraction does. Attachments count toward the compressed cap even though they're skipped.
- **Export.** The graph, notes and active memories can be exported as an Obsidian vault, so the learner's knowledge stays portable without files becoming the store.

**Consequences:**

- Mivra knows a returning learner's background from the first session.
- Saving automatically means one import can add many memories at once, some of them wrong. They are visible and deletable in the memory panel, and the `import` basis lets the panel filter or bulk-delete them.
- Distillation costs tokens in proportion to vault size, so it runs once per changed file, not per turn.
- Concept matching inherits ADR-009's synonym limits.
- Notes are read-only in the UI; writing in Mivra is a later decision.

**Build order:**

1. Note, link and tag tables, and the parse-and-index import.
2. Imported chunks in turn context.
3. Distillation, with `known` memories and concept edges.
4. Graph view in the web UI.
5. Vault export.
