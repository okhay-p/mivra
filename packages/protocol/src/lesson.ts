import { z } from "zod";

/**
 * Lessons (ADR-011): one per syllabus topic, generated when the learner reaches it. The outline comes
 * first, then one tool call per section, so each section validates on its own and appears as soon as it
 * is written. A finished lesson is frozen.
 */

/** Section kinds the outline can plan: prose, or an existing artifact kind by its tool's purpose. */
export const LessonSectionKind = z.enum(["prose", "algorithm_trace", "graph", "multiple_choice", "set_diagram", "table", "worked_steps"]);
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
        z.object({ id: z.string(), title: z.string(), kind: z.literal("prose"), markdown: z.string() }).strict(),
        z.object({ id: z.string(), title: z.string(), kind: z.literal("artifact"), artifact: z.unknown() }).strict(),
      ]),
    ),
    checks: z.object({ total: z.number().int().nonnegative(), answered: z.number().int().nonnegative() }).strict(),
    /** Whether the learner can finish it now: fully written and every check answered. */
    canFinish: z.boolean(),
    error: z.string().nullable(),
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
