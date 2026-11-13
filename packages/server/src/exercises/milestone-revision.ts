import { createHash } from "node:crypto";
import { activeMilestoneCases, type ProjectMilestoneSpec } from "@mivra/protocol";

/** Names the cases a check runs: a check sent for other cases (a dispute changed them meanwhile) is refused. */
export function milestoneRevision(spec: ProjectMilestoneSpec): string {
  const active = activeMilestoneCases(spec).map((c) => [c.index, c.name, c.input, c.compare ?? "stdout", c.expected]);
  return createHash("sha256").update(JSON.stringify([spec.checkType, active])).digest("hex").slice(0, 16);
}

/**
 * Whether a stored check ran the milestone's current cases. A dispute that withdraws or corrects a case changes them,
 * and a check of the old cases can then no longer pass or have its review saved: the learner checks again.
 */
export function checkIsCurrent(spec: ProjectMilestoneSpec, answer: unknown): boolean {
  return (answer as { revision?: unknown } | undefined)?.revision === milestoneRevision(spec);
}
