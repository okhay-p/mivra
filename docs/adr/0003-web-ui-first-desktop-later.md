---
status: accepted
date: 29 October 2026
---

# ADR-003: Web UI first, native desktop later

**Context:** Native apps are the long-term goal, but a web UI is the fastest way to iterate on lessons and visualizations.

**Decision:** The first client is a web UI served by the local Mivra server. A native desktop app comes later, most likely Electron, packaging the same web UI and launching the server automatically.

**Consequences:** The web client must reach the server only through its API and never depend on browser-only or Node-only shortcuts, so it can move into Electron unchanged. The server must run headless as its own process. A terminal UI and mobile clients are not ruled out, but are not planned yet.

**Still open:** Electron vs alternatives (e.g. Tauri) when the desktop work starts; how the desktop app spawns and supervises the server.
