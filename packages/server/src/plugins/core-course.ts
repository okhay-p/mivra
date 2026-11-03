import {
  PlacementAnswer,
  PlacementQuestionSpec,
  SyllabusInput,
  artifactKinds,
  gradePlacementQuestion,
  toPlacementQuestionPublic,
  type PlacementGrade,
} from "@mivra/protocol";
import { tool } from "ai";
import type { Plugin, TurnContext } from "../runtime/capabilities.js";

const interviewing = ({ sessionId, store }: TurnContext) => store.findCourseBySession(sessionId)?.status === "interviewing";

/**
 * Courses (ADR-011), stage 1: the placement interview's question kind and the tool that writes the
 * syllabus. Both are only offered while the session's course is still interviewing.
 */
export const coreCourse: Plugin = {
  name: "core-course",
  capabilities: ["artifactKinds", "tools"],
  setup(api) {
    const placement = artifactKinds.placement_question;
    api.registerArtifactKind({
      kind: "placement_question",
      version: placement.version,
      toolName: placement.toolName,
      description: placement.description,
      spec: placement.input,
      availableIn: interviewing,
      toView: ({ id, createdAt, spec, attempt }) => ({
        id,
        createdAt: createdAt.toISOString(),
        kind: "placement_question",
        version: 1,
        spec: toPlacementQuestionPublic(PlacementQuestionSpec.parse(spec)),
        ...(attempt
          ? {
              latestAttempt: {
                answer: PlacementAnswer.parse(attempt.answer),
                grade: attempt.grade as PlacementGrade,
                createdAt: attempt.createdAt.toISOString(),
              },
            }
          : {}),
      }),
      check: {
        answer: PlacementAnswer,
        grade: (spec, answer) => {
          const grade = gradePlacementQuestion(PlacementQuestionSpec.parse(spec), PlacementAnswer.parse(answer));
          return { correct: grade.result === "correct", grade };
        },
        // A skip says nothing about what the learner knows, so it isn't evidence. "Not sure" is.
        concept: (spec, answer) => ("skipped" in PlacementAnswer.parse(answer) ? undefined : PlacementQuestionSpec.parse(spec).concept),
        describeAttempt: (spec, attempt) => {
          if (!attempt) return { learnerResult: "not answered yet" };
          const { options } = PlacementQuestionSpec.parse(spec);
          const answer = PlacementAnswer.parse(attempt.answer);
          const { result } = attempt.grade as PlacementGrade;
          return "optionIndex" in answer
            ? { learnerResult: result, learnerChose: { optionIndex: answer.optionIndex, text: options[answer.optionIndex]?.text } }
            : { learnerResult: result === "unsure" ? "not sure" : "skipped" };
        },
      },
    });

    api.registerTool(
      "write_syllabus",
      ({ sessionId, runId, store }) =>
        tool({
          description:
            "Course placement interview only: write the course's syllabus once the placement questions are answered (or the learner asked to skip them). This ends the interview; the syllabus is used straight away, without asking the learner to approve it. Order topics from first to last, give each a reason tied to this learner, and keep it finite: roughly 3-12 topics.",
          inputSchema: SyllabusInput,
          execute: async (input) => {
            const course = store.findCourseBySession(sessionId);
            if (!course) return { status: "rejected", reason: "This session isn't a course." };
            const written = store.writeFirstSyllabus(course.id, runId, input);
            if (!written) return { status: "rejected", reason: "This course already has a syllabus." };
            return { status: "written", version: written.version, topics: input.topics.length };
          },
        }),
      { availableIn: interviewing },
    );
  },
};
