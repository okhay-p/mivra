---
status: accepted
date: 29 October 2026
---

# ADR-004: Hono as the server framework

**Context:** The server needs streaming agent output, a typed client for the web UI, an open API that other clients can use later (TUI, mobile, community-built), plugin-contributed routes, and must run on Node inside Electron (ADR-001, ADR-003).

**Options:** Hono — small, built on the web-standard Request/Response API, built-in SSE helper and typed client (hc), OpenAPI via @hono/zod-openapi. Fastify — most mature, strong isolated plugin system, but typed clients need code generation and SSE is manual. tRPC — best end-to-end types, but ties the API to TypeScript clients, which conflicts with the open client/server design.

**Decision:** The server is written in TypeScript with Hono. Routes are defined with @hono/zod-openapi so one Zod schema per endpoint gives validation, a typed client for the web UI, and an OpenAPI spec other clients can generate SDKs from. Agent output streams over SSE; commands use ordinary HTTP requests.

**Consequences:** The server runs on Node, Bun or inside Electron unchanged. Mivra's plugin system is its own layer rather than a framework feature (ideas such as plugin isolation and lifecycle hooks can be borrowed from Fastify). If the API grows large, split it into sub-apps to keep the typed client's type checking fast.

**Still open:** supporting libraries — proposals on [Foundation — Tech Stack & Deployment](https://app.notion.com/p/408fb102b9b6811b9f1ffc20fb46c928) (Notion).
