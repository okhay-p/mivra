---
status: accepted
date: 31 October 2026
---

# ADR-010: Uploaded documents — local text extraction

**Context:** Learners want to study from their own PDFs and slides, and the message box accepts only text.

**Options:** (A) extract text locally and store it; (B) send the original file to the model provider; (C) both.

**Decision:** (A). The server extracts text from PDF and PPTX files, up to about 25 MB each, and stores it in SQLite. Documents attach to a session. Each turn the tutor receives a capped amount of the relevant text, chosen with SQLite full-text search, through assembleContext, as data rather than instructions.

**Consequences:** Works with any model and needs no provider support; file contents reach the provider only as the excerpts a turn selects. Diagrams and images are lost, which matters for slides, so (C) may be added later. Starts on the full-text search ADR-009 calls for.

**Display:** A ready document appears in the composer until a message is accepted, then its removable chip appears on that user message, durably across reloads. Documents still being read wait for the next send. This association controls display only: every attached document remains available to subsequent turns in the session until removed. Existing unassociated documents remain in the composer until sent.
