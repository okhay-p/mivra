---
status: accepted
date: 3 November 2026
---

# ADR-011: Courses, syllabus and lessons — a finite, adaptive learning structure

**Context:** Learning happens only in chat today. The tutor prompt says to teach, check, then respond to the result, with no scope and no stopping point, so a topic never ends: each reply teaches the next idea and asks again. The README lists "the definition of learning success" as open. The workspace UI prototype (branch `prototype/workspace-ui`, commit 7c926e7) settled on a lesson-first page with the tutor in a Ctrl+K drawer, a placement interview, and keeping Explain (a question, lesson unchanged) separate from Change (an edit, new version).

**Options:** (A) keep chat-only and add a stopping rule to the prompt or a server-side mastery signal; (B) generate a whole lesson up front as one object; (C) generate a syllabus up front and each lesson just in time.

**Decision:** (C).

- **Structure.** A course has one learning goal. Its syllabus is an ordered list of topics, written after a placement interview that uses learner memory and concept state (ADR-009). Each topic gets one lesson, generated when the learner reaches it. A lesson is an ordered list of sections, each prose or an artifact of an existing kind (ADR-006). "Session" keeps meaning a chat session; it is not a unit of the course.
- **Generation.** A syllabus and a lesson are each written through validated tool calls: the outline first, then one call per section, so each section validates on its own and streams in while the learner reads. A lesson is generated when the previous one finishes, not ahead of time, so it can use the latest evidence.
- **Learner edits go through the tutor only.** The learner never edits text or reorders sections directly. Explain answers in the drawer and leaves the lesson unchanged. Change applies to the current lesson or to future topics, produces a new version, and highlights what changed.
- **Finished lessons are frozen.** A lesson is finished when the learner has reached its end and answered every check. Scores never block moving on. A finished lesson and its artifacts are never changed, so evidence and back-references always point at what the learner saw.
- **Mistakes shape the next lesson, not the current one.** Generating a lesson receives the previous lesson's outline and the attempts on it (missed checks, chosen wrong options). The new lesson opens by revisiting those mistakes and links back to the exact section in the earlier lesson.
- **The syllabus adapts automatically, within limits.** When the learner struggles, lesson generation may change the syllabus without asking: it may insert, split or reorder future topics only, never remove a topic the learner asked for, and make at most one change per finished lesson. Each change is shown with its reason (for example, "Added 'Chain rule refresher' before Backprop: you missed 3 of 4 checks on derivatives") and can be undone.
- **Success** for a course is reaching the end of the syllabus. Mastery from evidence (ADR-009) informs generation but does not gate progress.

**Consequences:** Courses, syllabus versions, lessons and section ordering need their own tables; artifacts stay immutable, and a lesson version is a new list of section references, so attempts on an earlier version stay attached to that version's artifacts. Turns gain a second shape beside chat: generating a syllabus or lesson, which can require more sequential model steps than today's five-step cap per turn, so generation needs its own step budget. The learner waits on each lesson's first section at the start of a topic. Automatic syllabus changes can still steer the plan somewhere the learner didn't want; the limits and undo keep this visible and reversible. Free chat stays available for questions outside a course. Course completion summaries, "up next" suggestions beyond the syllabus, spaced review across courses, and model-graded free-text checks come later.

**Build order:** course and syllabus tables with the placement interview → lesson generation with per-section streaming and the lesson page → the tutor drawer with Explain and Change → evidence-driven next lessons and automatic syllabus changes.
