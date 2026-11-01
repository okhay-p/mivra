---
status: accepted
date: 29 October 2026
---

# ADR-006: Learning contract — tool calls and Mivra-owned artifacts

**Context:** Visualizations and comprehension checks must be validated before rendering, stored durably, and gradable, without tying Mivra's data to the AI SDK's message format (stack review, October 2026).

**Options:** (A) tool calls whose Zod input schema is the contract; (B) structured blocks parsed out of the reply text; (C) a separate structured-output call after the explanation; (D) model-written HTML/JS in a sandboxed iframe.

**Decision:** (A) Tool calls. The agent calls tools such as show_visualization and ask_check; the server validates the input against versioned schemas in a shared packages/protocol package and stores the result as an artifact. Artifacts and learner attempts live in their own tables; messages reference them by id. The AI SDK stream stays as the transport for now, carrying Mivra-defined payloads, so the transport can be swapped behind an adapter. Learner answers go to the server (POST /api/artifacts/:id/attempts) and are graded there. Grading is deterministic only at first (multiple choice, numeric); model-graded free text comes later. Attempt results feed the next turn's context. Progress starts as evidence rows (concept label, outcome, source artifact); the full concept/memory model is a separate decision.

**Consequences:** Requires models with tool calling; on OpenRouter, choose models that list tool support. Every tool input schema must have required fields and no defaults that make an empty object valid: @openrouter/ai-sdk-provider 3.1.0 replaces unparseable (e.g. truncated) tool arguments with {} (found in the PR #3 review). (D) is rejected because it contradicts the Visualization Protocol's typed-descriptor principle.

**First kinds (decided 29 October 2026):** algorithm_trace (visualization) and multiple_choice (check). More kinds will be added later through the same schema + renderer + optional grader pattern.
