export interface SessionGroup<T> {
  label: string;
  sessions: T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Groups sessions by last activity for the sidebar, keeping their order and dropping empty groups. */
export function groupSessions<T extends { updatedAt: string }>(sessions: T[], now = new Date()): SessionGroup<T>[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: SessionGroup<T>[] = [
    { label: "Today", sessions: [] },
    { label: "Previous 7 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of sessions) {
    const at = new Date(session.updatedAt).getTime();
    const group = at >= today ? groups[0] : at >= today - 7 * DAY_MS ? groups[1] : groups[2];
    group!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
