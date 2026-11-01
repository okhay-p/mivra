---
status: accepted
date: 29 October 2026
---

# ADR-001: Standalone local-first app with client/server split

**Context:** Mivra must work fully locally, but later should allow other devices (e.g. mobile) to connect. OpenCode's client/server model is the reference.

**Decision:** Mivra is open source and fully functional locally — no account, cloud service or subscription. The default install feels like a standalone app that launches its own server automatically. Server logic (agent runtime, plugins, storage) is separated from client presentation behind an API, even when both ship as one package. Additional clients may connect to a running server only when the user explicitly enables secure network access. Remote access means connecting to the same server and its database — not syncing databases between devices.

**Consequences:** Plugins and agent execution live server-side, independent of any client. Offline multi-device sync, managed hosting and billing are out of MVP scope (wishlist only).

**Still open within this decision:** packaging and process model (spawned vs embedded server), HTTP + streaming protocol and API contracts, auth and network exposure controls, plugin lifecycle, local packaging/update experience.

**Detail:** [Architecture Direction — Standalone & Remote Clients](https://app.notion.com/p/408fb102b9b681cdb18bccd5a697408f) (Notion)
