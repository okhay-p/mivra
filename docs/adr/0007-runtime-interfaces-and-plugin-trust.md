---
status: accepted
date: 29 October 2026
---

# ADR-007: Runtime interfaces and plugin trust model

**Context:** The chat route currently owns storage, context assembly and model calls. Plugins need stable places to plug into, but designing a full plugin system before any real plugin exists risks wrong abstractions.

**Options:** Design interfaces first; build features first and extract later; or build them together, with the learning tools as the first internal plugin.

**Decision:** Build them together. Extract only: SessionStore (the sole Drizzle user), TurnRunner (context assembly, model call with registered tools, run outcome), a capability registry (registerTool, registerArtifactKind with schema and optional grader), and a context-assembly step where memory will plug in. The step 3 learning tools are registered through this API as a first-party core-learning module. Plugins run in-process and are trusted for now; each declares its capabilities in a manifest so isolation (worker/subprocess) can be added later without rewriting plugins. Visualization renderers are built-in, trusted UI components; third-party UI (e.g. sandboxed iframes) is deferred.

**Consequences:** The internal API is unstable until a second real plugin exists. No general event bus, plugin loading, or hot reload until needed.

**Build order:** packages/protocol → extract SessionStore and TurnRunner → capability registry and core-learning tools → artifacts/attempts tables, endpoints and grading → web renderers → end-to-end test.
