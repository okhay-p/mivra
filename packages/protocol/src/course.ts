import { z } from "zod";

/**
 * Courses (ADR-011): one learning goal, a placement interview, then a syllabus of ordered topics
 * written by the AI. The learner never approves the syllabus; they change it later through the tutor.
 */

export const MAX_GOAL_CHARS = 300;
export const CourseGoal = z.string().trim().min(1).max(MAX_GOAL_CHARS);

/**
 * A course's kind (ADR-016): `lessons` teaches through lessons with checks; `project` builds one project in the
 * learner's own repository, a milestone per syllabus topic, checked there with `mivra check`.
 */
export const COURSE_KINDS = ["lessons", "project"] as const;
export const CourseKind = z.enum(COURSE_KINDS);
export type CourseKind = z.infer<typeof CourseKind>;

/** Body of POST /courses. */
export const StartCourse = z.object({ goal: CourseGoal, kind: CourseKind.optional() }).strict();
export type StartCourse = z.infer<typeof StartCourse>;

const ConceptName = z.string().trim().min(1).max(80);

// ---------------------------------------------------------------------------------------------
// placement_question v1: one interview question. Multiple choice, true/false or yes/no, and the
// learner can always answer "Not sure" or skip it. No confidence rating (owner decision on #1).
// ---------------------------------------------------------------------------------------------

export const PlacementQuestionSpec = z
  .object({
    concept: ConceptName.describe('The single concept this question probes, e.g. "chain rule". Reuse the exact name from the learner\'s record when it is there.'),
    question: z.string().trim().min(1).max(1000),
    options: z
      .array(z.object({ text: z.string().trim().min(1).max(300) }).strict())
      .min(2)
      .max(5)
      .describe('2-5 options with distinct text. For true/false or yes/no use two options, e.g. "True" and "False". Never add a "Not sure" option: the UI always offers one.'),
    correctOptionIndex: z.number().int().nonnegative().describe("0-based index of the single correct option."),
    explanation: z.string().trim().min(1).max(600).describe("One or two sentences shown after answering: why the correct option is correct."),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.correctOptionIndex >= spec.options.length) {
      ctx.addIssue({ code: "custom", path: ["correctOptionIndex"], message: "correctOptionIndex must point at one of the options" });
    }
    const seen = new Map<string, number>();
    spec.options.forEach((option, i) => {
      const key = option.text.normalize("NFC");
      const first = seen.get(key);
      if (first !== undefined) ctx.addIssue({ code: "custom", path: ["options", i, "text"], message: `duplicates option ${first}` });
      else seen.set(key, i);
      if (/^\s*(not sure|i don'?t know|unsure|skip)\W*$/i.test(option.text)) {
        ctx.addIssue({ code: "custom", path: ["options", i, "text"], message: "Leave out Not sure / Skip: the UI always offers them" });
      }
    });
  });
export type PlacementQuestionSpec = z.infer<typeof PlacementQuestionSpec>;

/** What the client sees before answering. */
export const PlacementQuestionPublic = z
  .object({ concept: z.string(), question: z.string(), options: z.array(z.object({ text: z.string() }).strict()) })
  .strict();
export type PlacementQuestionPublic = z.infer<typeof PlacementQuestionPublic>;

export const toPlacementQuestionPublic = (spec: PlacementQuestionSpec): PlacementQuestionPublic => ({
  concept: spec.concept,
  question: spec.question,
  options: spec.options.map((o) => ({ text: o.text })),
});

export const PlacementAnswer = z.union([
  z.object({ optionIndex: z.number().int().nonnegative() }).strict(),
  z.object({ unsure: z.literal(true) }).strict(),
  z.object({ skipped: z.literal(true) }).strict(),
]);
export type PlacementAnswer = z.infer<typeof PlacementAnswer>;

export const PlacementResult = z.enum(["correct", "incorrect", "unsure", "skipped"]);
export type PlacementResult = z.infer<typeof PlacementResult>;

export const PlacementGrade = z
  .object({ result: PlacementResult, correctOptionIndex: z.number().int().nonnegative(), explanation: z.string() })
  .strict();
export type PlacementGrade = z.infer<typeof PlacementGrade>;

/** Deterministic grader. "Not sure" counts as not knowing it; a skip is no evidence either way. */
export function gradePlacementQuestion(spec: PlacementQuestionSpec, answer: PlacementAnswer): PlacementGrade {
  let result: PlacementResult;
  if ("optionIndex" in answer) {
    if (!spec.options[answer.optionIndex]) throw new RangeError(`optionIndex ${answer.optionIndex} is not one of the ${spec.options.length} options`);
    result = answer.optionIndex === spec.correctOptionIndex ? "correct" : "incorrect";
  } else result = "unsure" in answer ? "unsure" : "skipped";
  return { result, correctOptionIndex: spec.correctOptionIndex, explanation: spec.explanation };
}

// ---------------------------------------------------------------------------------------------
// interview_context v1: the interview's one optional free-text question (#75), asked last, so the
// learner can say in their own words what they already know or want to explore. Not graded and
// never evidence: the answer only tailors the syllabus.
// ---------------------------------------------------------------------------------------------

/** Most characters the learner can write in the interview's free-text answer. */
export const MAX_INTERVIEW_CONTEXT_CHARS = 2000;

export const InterviewContextSpec = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe('The question, e.g. "Anything else you\'d like us to know about what you already understand or what you want to explore?"'),
  })
  .strict();
export type InterviewContextSpec = z.infer<typeof InterviewContextSpec>;

/** The learner's words, or a skip. Blank text counts as a skip. */
export const InterviewContextAnswer = z.union([
  z.object({ text: z.string().trim().max(MAX_INTERVIEW_CONTEXT_CHARS) }).strict(),
  z.object({ skipped: z.literal(true) }).strict(),
]);
export type InterviewContextAnswer = z.infer<typeof InterviewContextAnswer>;

export const InterviewContextGrade = z.object({ result: z.enum(["answered", "skipped"]) }).strict();
export type InterviewContextGrade = z.infer<typeof InterviewContextGrade>;

/** Not a grade so much as a label: whether the learner wrote anything. */
export const gradeInterviewContext = (answer: InterviewContextAnswer): InterviewContextGrade => ({
  result: "text" in answer && answer.text.length > 0 ? "answered" : "skipped",
});

// ---------------------------------------------------------------------------------------------
// Syllabus
// ---------------------------------------------------------------------------------------------

export const KnownSource = z.enum(["memory", "test", "guess"]);
export type KnownSource = z.infer<typeof KnownSource>;

export const SyllabusTopicInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(400).describe("What the lesson on this topic will cover, in one or two sentences."),
    reason: z.string().trim().min(1).max(300).describe('Why this topic is here for this learner, e.g. "You missed the question on local minima".'),
    requestedByLearner: z.boolean().describe("True if the learner explicitly asked for this topic. Such topics are never removed automatically."),
    concepts: z.array(ConceptName).min(1).max(8).describe("Concept names this topic teaches; reuse names from the learner's record and the placement questions."),
  })
  .strict();

/**
 * Subject icons a course can have, by Lucide name (#58). The tutor picks one when it writes the first
 * syllabus; clients map the name to an icon and fall back to a graduation cap for none or an unknown name.
 */
export const courseIcons = [
  "sigma",
  "calculator",
  "code",
  "terminal",
  "cpu",
  "database",
  "network",
  "shield",
  "flask-conical",
  "atom",
  "dna",
  "leaf",
  "telescope",
  "globe",
  "landmark",
  "book-open",
  "pen-tool",
  "languages",
  "music",
  "palette",
  "camera",
  "brain",
  "users",
  "chart-line",
  "briefcase",
  "scale",
  "stethoscope",
  "heart-pulse",
  "wrench",
  "dumbbell",
] as const;
export const CourseIcon = z.enum(courseIcons);
export type CourseIcon = z.infer<typeof CourseIcon>;

/** Most characters in the title the tutor gives a course. */
export const COURSE_TITLE_MAX = 60;

/** Input of the write_syllabus tool. The server adds ids, version and timestamps. */
export const SyllabusInput = z
  .object({
    // Bad values parse as missing rather than failing the call: a syllabus is worth more than its label (#58).
    title: z
      .string()
      .trim()
      .min(1)
      .max(COURSE_TITLE_MAX)
      .optional()
      .catch(undefined)
      .describe('A short name for the course, 2-5 words, shown in the sidebar, e.g. "Discrete Math: Induction". Name what the syllabus covers, not the request.'),
    icon: CourseIcon.optional()
      .catch(undefined)
      .describe("The subject icon that best fits the course: sigma = maths, calculator = arithmetic or accounting, code/terminal = programming, cpu = hardware, flask-conical = chemistry, atom = physics, dna = biology, leaf = ecology, telescope = astronomy, globe = geography, landmark = history, book-open = literature, pen-tool = writing, languages = languages, palette = art, brain = psychology, users = sociology, chart-line = economics or statistics, briefcase = business, scale = law, stethoscope/heart-pulse = medicine, wrench = engineering, dumbbell = sport."),
    topics: z.array(SyllabusTopicInput).min(1).max(20).describe("The ordered topics, first to learn first. Each topic gets one lesson."),
    known: z
      .array(
        z
          .object({
            concept: ConceptName,
            source: KnownSource.describe("memory = from their record or memories; test = from this placement interview; guess = your inference"),
            note: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .max(20)
      .describe("What the learner already knows or doesn't, each labelled with where that comes from. Shown to the learner."),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.topics.forEach((topic, i) => {
      const key = topic.title.trim().toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["topics", i, "title"], message: "Topic titles must be distinct" });
      seen.add(key);
    });
  });
export type SyllabusInput = z.infer<typeof SyllabusInput>;

export const SyllabusTopic = SyllabusTopicInput.extend({ id: z.string() }).strict();
export type SyllabusTopic = z.infer<typeof SyllabusTopic>;

export const SyllabusView = z
  .object({
    version: z.number().int().positive(),
    source: z.enum(["interview", "tutor", "adaptive", "undo"]),
    reason: z.string().nullable(),
    changedTopicIds: z.array(z.string()),
    /** Whether the learner can undo this version: an automatic change none of whose new topics has started. */
    canUndo: z.boolean(),
    topics: z.array(SyllabusTopic),
    known: SyllabusInput.shape.known,
    createdAt: z.string().datetime(),
  })
  .strict();
export type SyllabusView = z.infer<typeof SyllabusView>;

export const CourseStatus = z.enum(["interviewing", "active", "complete"]);
export type CourseStatus = z.infer<typeof CourseStatus>;

export const CourseView = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    goal: z.string(),
    kind: CourseKind,
    status: CourseStatus,
    syllabus: SyllabusView.nullable(),
    /** The tutor's reply that wrote the first syllabus, which ends the placement interview; null if unknown. */
    interviewMessageId: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CourseView = z.infer<typeof CourseView>;
