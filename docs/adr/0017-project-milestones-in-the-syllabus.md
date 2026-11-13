---
status: proposed
date: 13 November 2026
---

# ADR-017: Project milestones in the syllabus, and how they freeze

**Context:** ADR-016 (accepted) adds project courses whose units are milestones, checked in the learner's repository with `mivra check`, and leaves open how milestones fit ADR-011's syllabus and freezing. ADR-011 gives every course a syllabus of topics, one lesson per topic written just in time, checks answered once, scores that never block moving on, and finished lessons that are frozen. A milestone is checked many times while the learner builds it.

**Options:**

- (A) Milestones as their own table beside the syllabus, with their own progress and freezing.
- (B) A project course is an ordinary course whose topics are milestones: each topic's lesson ends with one milestone artifact, and the lesson's rules apply to it.

**Decision (proposed):** (B).

- **Course kind.** A course is `lessons` or `project`, chosen when it starts. A project course's placement interview also asks the learner's language; its syllabus is 3-10 milestones, each topic one step of the program. Change and adaptive changes work on milestones as on topics.
- **One milestone per lesson.** A project lesson's outline ends with exactly one `project_milestone` section, after a few sections that teach what it needs; a multiple-choice check is optional. The milestone tool is offered only while a project course's lesson is written, and a lesson Change can't remove it.
- **Checked many times, recorded once.** Each `mivra check` replaces the milestone's single attempt, so the attempt (and the evidence it gives, ADR-009) is always the latest result. Check history isn't kept.
- **Scores never block.** A milestone counts as answered once it has been checked at least once, passing or not, so the lesson can be finished as ADR-011 allows. Passing still needs every test to pass (and, once it lands, the review, ADR-016).
- **Frozen when finished.** Finishing the lesson freezes the milestone: further checks are refused, and `mivra check` targets the milestone of the first unfinished lesson.

**Consequences:** No new tables beyond the course's kind; lessons, versions, adaptive changes and completion work unchanged. A learner can move on with a failing milestone, which later milestones may then expose. Only the latest check is visible, so the tutor can't see how many tries a pass took. Review milestones and disputes (ADR-016 step 4) attach to the same artifact.
