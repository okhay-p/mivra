---
status: accepted
date: 29 October 2026
---

# ADR-002: SQLite for local storage

**Context:** Core local use must not require a separately managed database server and must work offline (ADR-001).

**Decision:** SQLite is the database, owned by the Mivra server. Clients never open the database directly; they go through the server API.

**Consequences:** Single-file data that is easy to back up. Remote clients use the same server and database rather than syncing. Access should sit behind a storage interface so a later sync layer does not force rewrites.

**Still open:** backup approach, schema versioning. (Driver and migration tooling were settled in ADR-005.)

**Detail:** [Foundation — Local-First Storage & Cloud Sync](https://app.notion.com/p/408fb102b9b681c5b636d60cdfd891d7) (Notion)
