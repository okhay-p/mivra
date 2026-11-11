import { describe, expect, it } from "vitest";
import { CourseView, InterviewContextAnswer, InterviewContextSpec, MAX_INTERVIEW_CONTEXT_CHARS, gradeInterviewContext, PlacementAnswer, PlacementQuestionSpec, StartCourse, SyllabusInput, gradePlacementQuestion, toPlacementQuestionPublic } from "../src/index.js";

const question = {
  concept: "derivative of a constant",
  question: "What is the derivative of 7?",
  options: [{ text: "0" }, { text: "7" }, { text: "1" }],
  correctOptionIndex: 0,
  explanation: "A constant doesn't change, so its rate of change is 0.",
};

const syllabus = {
  topics: [{ title: "Limits", summary: "What a limit is.", reason: "You weren't sure about limits.", requestedByLearner: false, concepts: ["limit"] }],
  known: [{ concept: "derivative of a constant", source: "test", note: "Answered correctly." }],
};

describe("placement_question", () => {
  it("accepts a valid question and rejects {}", () => {
    expect(PlacementQuestionSpec.safeParse(question).success).toBe(true);
    expect(PlacementQuestionSpec.safeParse({}).success).toBe(false);
  });

  it("accepts true/false with two options", () => {
    expect(PlacementQuestionSpec.safeParse({ ...question, options: [{ text: "True" }, { text: "False" }], correctOptionIndex: 1 }).success).toBe(true);
  });

  it.each(["Not sure", "I don't know", "skip"])("rejects a %s option, which the UI always adds", (text) => {
    expect(PlacementQuestionSpec.safeParse({ ...question, options: [...question.options, { text }] }).success).toBe(false);
  });

  it("rejects a correct index outside the options and duplicate options", () => {
    expect(PlacementQuestionSpec.safeParse({ ...question, correctOptionIndex: 3 }).success).toBe(false);
    expect(PlacementQuestionSpec.safeParse({ ...question, options: [{ text: "0" }, { text: "0" }] }).success).toBe(false);
  });

  it("keeps the answer key out of the public view", () => {
    expect(JSON.stringify(toPlacementQuestionPublic(PlacementQuestionSpec.parse(question)))).not.toMatch(/correctOptionIndex|explanation/);
  });

  it("grades a choice, Not sure and Skip", () => {
    const spec = PlacementQuestionSpec.parse(question);
    expect(gradePlacementQuestion(spec, { optionIndex: 0 }).result).toBe("correct");
    expect(gradePlacementQuestion(spec, { optionIndex: 1 }).result).toBe("incorrect");
    expect(gradePlacementQuestion(spec, { unsure: true }).result).toBe("unsure");
    expect(gradePlacementQuestion(spec, { skipped: true }).result).toBe("skipped");
    expect(() => gradePlacementQuestion(spec, { optionIndex: 9 })).toThrow(RangeError);
  });

  it("accepts only one answer shape", () => {
    expect(PlacementAnswer.safeParse({}).success).toBe(false);
    expect(PlacementAnswer.safeParse({ unsure: false }).success).toBe(false);
    expect(PlacementAnswer.safeParse({ optionIndex: 0, unsure: true }).success).toBe(false);
  });
});

describe("interview_context", () => {
  it("accepts a question and rejects {}", () => {
    expect(InterviewContextSpec.safeParse({ question: "Anything else?" }).success).toBe(true);
    expect(InterviewContextSpec.safeParse({}).success).toBe(false);
    expect(InterviewContextSpec.safeParse({ question: "  " }).success).toBe(false);
  });

  it("takes the learner's words, trimmed and capped, or a skip", () => {
    expect(InterviewContextAnswer.parse({ text: "  I know limits.\n" })).toEqual({ text: "I know limits." });
    expect(InterviewContextAnswer.safeParse({ text: "x".repeat(MAX_INTERVIEW_CONTEXT_CHARS) }).success).toBe(true);
    expect(InterviewContextAnswer.safeParse({ text: "x".repeat(MAX_INTERVIEW_CONTEXT_CHARS + 1) }).success).toBe(false);
    expect(InterviewContextAnswer.safeParse({}).success).toBe(false);
    expect(InterviewContextAnswer.safeParse({ skipped: false }).success).toBe(false);
    expect(InterviewContextAnswer.safeParse({ text: "hi", skipped: true }).success).toBe(false);
  });

  it("labels blank text as skipped", () => {
    expect(gradeInterviewContext(InterviewContextAnswer.parse({ text: "Go deep on backprop" })).result).toBe("answered");
    expect(gradeInterviewContext(InterviewContextAnswer.parse({ text: "   " })).result).toBe("skipped");
    expect(gradeInterviewContext({ skipped: true }).result).toBe("skipped");
  });
});

describe("syllabus", () => {
  it("accepts a valid syllabus and rejects {}", () => {
    expect(SyllabusInput.safeParse(syllabus).success).toBe(true);
    expect(SyllabusInput.safeParse({}).success).toBe(false);
  });

  it("rejects duplicate topic titles and empty topic lists", () => {
    expect(SyllabusInput.safeParse({ ...syllabus, topics: [syllabus.topics[0], { ...syllabus.topics[0], title: " limits " }] }).success).toBe(false);
    expect(SyllabusInput.safeParse({ ...syllabus, topics: [] }).success).toBe(false);
  });

  it("rejects an unknown source label", () => {
    expect(SyllabusInput.safeParse({ ...syllabus, known: [{ ...syllabus.known[0], source: "vibes" }] }).success).toBe(false);
  });

  it("validates a course view and the start body", () => {
    expect(StartCourse.safeParse({ goal: "  " }).success).toBe(false);
    expect(StartCourse.safeParse({ goal: "Calculus" }).success).toBe(true);
    expect(
      CourseView.safeParse({ id: "c", sessionId: "s", goal: "Calculus", status: "interviewing", syllabus: null, interviewMessageId: null, createdAt: new Date().toISOString() }).success,
    ).toBe(true);
  });
});

describe("lesson schemas", async () => {
  const { LessonOutlineInput, LessonSectionKind, LessonTextInput, artifactKinds } = await import("../src/index.js");

  it("plans every artifact kind except the interview's, plus prose", () => {
    const expected = [...Object.keys(artifactKinds).filter((k) => k !== "placement_question" && k !== "interview_context"), "prose"].sort();
    expect([...LessonSectionKind.options].sort()).toEqual(expected);
  });

  it("rejects {} and an outline without a check", () => {
    expect(LessonOutlineInput.safeParse({}).success).toBe(false);
    expect(LessonTextInput.safeParse({}).success).toBe(false);
    const sections = [{ title: "a", kind: "prose", purpose: "p" }, { title: "b", kind: "table", purpose: "p" }];
    expect(LessonOutlineInput.safeParse({ title: "t", sections }).success).toBe(false);
    expect(LessonOutlineInput.safeParse({ title: "t", sections: [...sections, { title: "c", kind: "multiple_choice", purpose: "p" }] }).success).toBe(true);
  });
});
