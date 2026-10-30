import { describe, expect, it } from "vitest";
import { groupSessions } from "../src/session-groups.js";

const now = new Date(2026, 9, 30, 12);
const at = (daysAgo: number, hour = 12) => ({ updatedAt: new Date(2026, 9, 30 - daysAgo, hour).toISOString() });

describe("groupSessions", () => {
  it("groups by last activity, keeping order and dropping empty groups", () => {
    const a = at(0, 1);
    const b = at(1, 23);
    const c = at(7);
    const d = at(9);
    expect(groupSessions([a, b, c, d], now)).toEqual([
      { label: "Today", sessions: [a] },
      { label: "Previous 7 days", sessions: [b, c] },
      { label: "Older", sessions: [d] },
    ]);
    expect(groupSessions([d], now).map((g) => g.label)).toEqual(["Older"]);
    // A week across a calendar boundary keeps its local-midnight cutoff.
    const justBefore = { updatedAt: new Date(2026, 9, 22, 23, 59).toISOString() };
    const justAfter = { updatedAt: new Date(2026, 9, 23, 0, 0).toISOString() };
    expect(groupSessions([justAfter, justBefore], now).map((g) => g.sessions)).toEqual([[justAfter], [justBefore]]);
  });
});
