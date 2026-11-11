import { z } from "zod";

/**
 * Lessons (ADR-011): one per syllabus topic, generated when the learner reaches it. The outline comes
 * first, then one tool call per section, so each section validates on its own and appears as soon as it
 * is written. A finished lesson is frozen.
 */

/** Section kinds the outline can plan: prose, or an existing artifact kind by its tool's purpose. */
export const LessonSectionKind = z.enum(["prose", "algorithm_trace", "code_walkthrough", "graph", "multiple_choice", "set_diagram", "table", "worked_steps"]);
export type LessonSectionKind = z.infer<typeof LessonSectionKind>;

export const MAX_LESSON_SECTIONS = 10;

export const LessonOutlineInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    sections: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            kind: LessonSectionKind.describe("prose = write_lesson_text; multiple_choice = ask_multiple_choice (a check); the others = the matching show_* tool."),
            purpose: z.string().trim().min(1).max(300).describe("What this section does for the learner, in one sentence."),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_LESSON_SECTIONS)
      .describe(`2-${MAX_LESSON_SECTIONS} sections in reading order. Include at least one multiple_choice check, usually after the idea it checks.`),
  })
  .strict()
  .superRefine((outline, ctx) => {
    if (!outline.sections.some((s) => s.kind === "multiple_choice")) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: "Include at least one multiple_choice check" });
    }
  });
export type LessonOutlineInput = z.infer<typeof LessonOutlineInput>;

export const LessonTextInput = z
  .object({
    markdown: z.string().trim().min(1).max(6000).describe("The section's prose, as markdown with $...$ and $$...$$ maths. Don't repeat the section title as a heading."),
    revisits: z
      .array(z.string().min(1))
      .max(5)
      .optional()
      .describe("sectionIds from <previous_lesson> this section revisits. The page links back to them, so don't write links yourself."),
  })
  .strict();
export type LessonTextInput = z.infer<typeof LessonTextInput>;

export const LessonStatus = z.enum(["generating", "ready", "failed", "finished"]);
export type LessonStatus = z.infer<typeof LessonStatus>;

export const LessonOutlineView = z
  .object({
    title: z.string(),
    sections: z.array(z.object({ title: z.string(), kind: LessonSectionKind }).strict()),
  })
  .strict();

/** A lesson as the client sees it. `artifact` holds an ArtifactView, validated by the client's renderer. */
export const LessonView = z
  .object({
    id: z.string(),
    courseId: z.string(),
    topicId: z.string(),
    topicTitle: z.string(),
    position: z.number().int().nonnegative(),
    status: LessonStatus,
    version: z.number().int().positive().nullable(),
    outline: LessonOutlineView.nullable(),
    sections: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            id: z.string(),
            title: z.string(),
            kind: z.literal("prose"),
            markdown: z.string(),
            /** Earlier sections this one revisits, for links back to exactly what the learner saw. */
            revisits: z.array(z.object({ lessonId: z.string(), sectionId: z.string(), title: z.string(), lessonTitle: z.string() }).strict()),
          })
          .strict(),
        z.object({ id: z.string(), title: z.string(), kind: z.literal("artifact"), artifact: z.unknown() }).strict(),
      ]),
    ),
    checks: z.object({ total: z.number().int().nonnegative(), answered: z.number().int().nonnegative() }).strict(),
    /** The course's current syllabus version, so a page can notice a change made while it was open. */
    syllabusVersion: z.number().int().positive().nullable(),
    /** Sections the latest version added or changed, highlighted for the learner, and why. */
    changedSectionIds: z.array(z.string()),
    changeReason: z.string().nullable(),
    /** Whether the learner can finish it now: fully written and every check answered. */
    canFinish: z.boolean(),
    error: z.string().nullable(),
    /** A failure the learner fixes elsewhere: "lesson-model" means the lesson model chosen in Settings can't be used. */
    errorAction: z.enum(["lesson-model"]).nullable(),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();
export type LessonView = z.infer<typeof LessonView>;

/** One row per syllabus topic, in syllabus order, with its lesson if one exists. */
export const CourseLessonsView = z
  .object({
    topics: z.array(
      z
        .object({
          topicId: z.string(),
          title: z.string(),
          lesson: z.object({ id: z.string(), status: LessonStatus }).strict().nullable(),
        })
        .strict(),
    ),
    /** The lesson to show: the first unfinished one, or the last one once all are finished. */
    currentLessonId: z.string().nullable(),
    /** The next topic without a lesson, if the learner may start it now. */
    nextTopicId: z.string().nullable(),
  })
  .strict();
export type CourseLessonsView = z.infer<typeof CourseLessonsView>;

const SectionTitle = z.string().trim().min(1).max(120);
const SectionMarkdown = z.string().trim().min(1).max(6000);
const Reason = z.string().trim().min(1).max(300);

/**
 * Input of change_lesson: the tutor's edit of the current lesson, on the learner's request (ADR-011).
 * One call makes one new version; the sections it adds or rewrites are highlighted.
 */
export const ChangeLessonInput = z
  .object({
    reason: Reason.describe('What the learner asked for, in a few words, e.g. "Simpler intro with an example".'),
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("rewrite"), sectionId: z.string().min(1), markdown: SectionMarkdown, title: SectionTitle.optional() }).strict()
            .describe("Replace a prose section's text (and optionally its title)."),
          z.object({ op: z.literal("insert"), afterSectionId: z.string().min(1).nullable(), title: SectionTitle, markdown: SectionMarkdown }).strict()
            .describe("Add a prose section after the given section, or first if null."),
          z.object({ op: z.literal("insert_artifact"), afterSectionId: z.string().min(1).nullable(), title: SectionTitle, artifactId: z.string().min(1) }).strict()
            .describe("Add a card you created earlier in this reply (its artifactId) as a section."),
          z.object({ op: z.literal("remove"), sectionId: z.string().min(1) }).strict(),
          z.object({ op: z.literal("move"), sectionId: z.string().min(1), afterSectionId: z.string().min(1).nullable() }).strict(),
        ]),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type ChangeLessonInput = z.infer<typeof ChangeLessonInput>;

/** Input of change_syllabus: the tutor's edit of the course's future topics, on the learner's request. */
export const ChangeSyllabusInput = z
  .object({
    reason: Reason.describe('What the learner asked for, e.g. "Add a topic on vectors before gradients".'),
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("insert"),
              afterTopicId: z.string().min(1).nullable().describe("Insert after this topic; null to insert before the first future topic."),
              title: SectionTitle,
              summary: z.string().trim().min(1).max(400),
              reason: Reason,
              concepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
            })
            .strict(),
          z.object({ op: z.literal("edit"), topicId: z.string().min(1), title: SectionTitle.optional(), summary: z.string().trim().min(1).max(400).optional() }).strict(),
          z.object({ op: z.literal("remove"), topicId: z.string().min(1) }).strict(),
          z.object({ op: z.literal("move"), topicId: z.string().min(1), afterTopicId: z.string().min(1).nullable() }).strict(),
        ]),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type ChangeSyllabusInput = z.infer<typeof ChangeSyllabusInput>;

/** Body of POST /lessons/{id}/sections: keep a tutor's Explain answer as a new section. */
export const AddToLesson = z
  .object({
    messageId: z.string().min(1).max(128),
    afterSectionId: z.string().min(1).max(128).nullable(),
    title: SectionTitle,
  })
  .strict();
export type AddToLesson = z.infer<typeof AddToLesson>;

const NewTopic = z
  .object({
    title: SectionTitle,
    summary: z.string().trim().min(1).max(400),
    concepts: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  })
  .strict();

/**
 * Input of adapt_syllabus: lesson generation's own change to future topics when the learner struggled
 * (ADR-011). Insert, split or reorder only; never removes a topic. At most one per finished lesson.
 */
export const AdaptSyllabusInput = z
  .object({
    reason: Reason.describe('Shown to the learner, with the evidence, e.g. "Added a chain rule refresher: you missed 3 of 4 checks on derivatives".'),
    operation: z.discriminatedUnion("op", [
      NewTopic.extend({ op: z.literal("insert"), afterTopicId: z.string().min(1).nullable().describe("null = straight after this lesson's topic") }).strict(),
      z.object({ op: z.literal("split"), topicId: z.string().min(1), into: z.array(NewTopic).min(2).max(3) }).strict(),
      z.object({ op: z.literal("move"), topicId: z.string().min(1), afterTopicId: z.string().min(1).nullable() }).strict(),
    ]),
  })
  .strict();
export type AdaptSyllabusInput = z.infer<typeof AdaptSyllabusInput>;
