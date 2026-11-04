import type { ArtifactView } from "@mivra/protocol";
import { Conflict, type SessionStore } from "../store/session-store.js";
import { artifactView } from "./artifacts.js";
import type { CapabilityRegistry } from "./capabilities.js";

export type AttemptError =
  | { kind: "not_found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string };

export type SubmitAttemptResult = { ok: true; view: ArtifactView } | { ok: false; error: AttemptError };

/** Grades a learner's answer to a check on the server, deterministically (ADR-006), and records it. */
export function submitAttempt(
  { artifactId, answer: input }: { artifactId: string; answer: unknown },
  {
    registry,
    store,
    durableOnceSaved = () => false,
  }: {
    registry: CapabilityRegistry;
    store: SessionStore;
    /** Artifacts kept as soon as they are saved, such as a lesson's sections, can be answered while their run continues. */
    durableOnceSaved?: (artifactId: string) => boolean;
  },
): SubmitAttemptResult {
  const artifact = store.findArtifact(artifactId);
  if (!artifact) return { ok: false, error: { kind: "not_found", message: "Artifact not found" } };
  const check = registry.artifactKind(artifact.kind)?.check;
  if (!check) return { ok: false, error: { kind: "invalid", message: "This artifact can't be answered" } };
  // Only a completed reply is kept, so only its checks count. While the reply is still streaming the
  // check could still be discarded, which would orphan the attempt. A lesson section stays even if the
  // rest of its generation fails, so it can be answered at once.
  if (!durableOnceSaved(artifactId)) {
    if (artifact.runStatus === "running") {
      return { ok: false, error: { kind: "conflict", message: "The reply is still in progress; answer once it finishes" } };
    }
    if (artifact.runStatus !== "completed") {
      return { ok: false, error: { kind: "conflict", message: "This check was discarded because its reply didn't finish" } };
    }
  }

  const answer = check.answer.safeParse(input);
  if (!answer.success) return { ok: false, error: { kind: "invalid", message: "Invalid answer" } };
  let graded: { correct: boolean; grade: unknown };
  try {
    graded = check.grade(artifact.spec, answer.data);
  } catch (error) {
    return { ok: false, error: { kind: "invalid", message: error instanceof Error ? error.message : "Invalid answer" } };
  }

  try {
    store.createAttempt({
      artifactId,
      sessionId: artifact.sessionId,
      answer: answer.data,
      grade: graded.grade,
      correct: graded.correct,
      concept: check.concept?.(artifact.spec, answer.data),
    });
  } catch (error) {
    if (error instanceof Conflict) return { ok: false, error: { kind: "conflict", message: error.message } };
    throw error;
  }
  return { ok: true, view: artifactView(artifactId, registry, store)! };
}
