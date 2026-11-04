---
status: proposed
date: 4 November 2026
---

# ADR-012: Model picker: one app-wide model and effort, chosen in the UI

**Context:** The model and reasoning effort come from `MIVRA_MODEL` and `MIVRA_REASONING_EFFORT` and are fixed when the server starts. The effort is set on the OpenRouter provider itself, so every call shares it. Switching models means editing `.env` and restarting. The provider registry (`packages/server/src/model.ts`) already resolves `anthropic`, `openai` and `openrouter` ids. Runs don't record which model produced them, yet the turn runner replays each step's provider metadata (such as reasoning signatures) on later turns. After a switch, that metadata would go to a model that never produced it, and some providers reject it.

**Options:** (A) keep env-only configuration; (B) one app-wide selection changed from the UI; (C) a selection per session; (D) a model per job (chat, syllabus, lessons).

**Decision:** (B). (D) is a later improvement; (C) is not planned.

- **One selection.** A `settings` table (key → JSON) holds the current `{ model, effort }`. Chat turns, syllabus generation and lesson generation all use it. The env vars only seed it on first run. `PUT /api/settings/model` validates the model against the catalog and the effort against the known levels.
- **Effort per call.** Effort moves from the provider's `extraBody` to each call's `providerOptions`, so changing it needs no restart. A change applies from the next run; a run already streaming keeps its model.
- **Runs record their model.** `runs` gains `model` and `effort`. On replay, provider metadata and signed reasoning are sent back only for replies from the same model; replies from another model replay as text.
- **Catalog.** `GET /api/models` serves OpenRouter's public model list (`/api/v1/models`) filtered to models whose `supported_parameters` include `tools`, since the learning tools need tool calling. Each entry carries id, name, context length, price and whether it supports `reasoning`. The server caches it in memory for about an hour and falls back to the last good copy when offline.
- **Picker.** A searchable picker in the composer (shadcn `popover` + `command`). Unsearched, it shows only Recent (the last 5 models used), Pinned (models the learner starred) and Suggested (about 8 tool-capable models shipped in server config, hidden once the learner has enough of their own; any that leave the catalog are dropped silently). Typing searches the whole catalog. `pinned` and `recent` live in `settings`; `recent` updates when a run starts. The effort control (Default, none, minimal, low, medium, high, xhigh) appears only for models that support reasoning; Default omits the parameter.
- **Provenance in the UI.** Each assistant reply shows the model that wrote it, from its run.

**Consequences:** Model choice becomes data rather than deployment config, and every reply can be traced to its model. Switching mid-session costs earlier replies' reasoning context. The catalog depends on OpenRouter being reachable at least once; tests and e2e inject a fixed catalog. Background generation can't use a cheaper model than chat until (D).

**Build order:**

1. OpenRouter: settings table, catalog endpoint, per-call effort, run provenance and the same-model replay rule, the picker, and the model label on replies.
2. Direct providers: the catalog groups by provider and lists only providers whose API key is set (OpenRouter, Anthropic, OpenAI). A per-provider mapping turns the effort level into each provider's option, such as Anthropic's thinking setting or OpenAI's `reasoningEffort`.
3. Later: sign-in with a ChatGPT subscription via OAuth. First confirm that OpenAI permits third-party apps to use subscription credentials; this needs its own ADR. Also later: a model per job (D).
