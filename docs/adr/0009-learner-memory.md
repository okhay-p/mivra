---
status: accepted
date: 31 October 2026
---

# ADR-009: Learner memory — evidence, derived concept state, and automatic memories

**Context:** Every session starts from nothing, and each turn sends the whole conversation to the model. A new session should recover the learner's goal and an earlier misconception without the old chat.

**Options:** Saving memories automatically or after learner approval; global or per-subject memory; embeddings or structured search.

**Decision:** Facts and guesses stay separate. Evidence is what the server records from grading (the attempts table). Concept state is calculated from evidence, not stored. Memory entries (goals, preferences, misconceptions) are the model's inferences, written through a validated remember tool, with the server attaching source and timestamp; a newer entry replaces an older one without erasing it. Memories save automatically, and all are visible, editable and deletable in a memory panel. There is one global memory across all sessions. A misconception links to a wrong answer when one exists, and is marked lower confidence when it comes only from chat. Each turn's context is assembled within a token budget through the assembleContext hook: a short block of what Mivra knows, recent messages word for word, and a summary in place of older ones. Retrieval uses structured filters plus SQLite full-text search, without embeddings for now. Stored text is passed to the model as data, not instructions.

**Consequences:** A wrong guess can influence replies until the learner notices and corrects it. Concept names are model-written, so the model is shown existing names to reuse and names are normalised; this won't catch every synonym. Per-subject scoping, spaced review and measuring recall and memory pollution come later.

**Build order:** concept state across sessions → remember tool and memory panel → summaries and token budget.
