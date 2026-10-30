export interface SessionGroup<T> {
  label: string;
  sessions: T[];
}

/** Groups sessions by last activity for the sidebar, keeping their order and dropping empty groups. */
export function groupSessions<T extends { updatedAt: string }>(sessions: T[], now = new Date()): SessionGroup<T>[] {
  // Calendar arithmetic, not 24-hour steps, so daylight saving changes don't move the boundaries.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime();
  const groups: SessionGroup<T>[] = [
    { label: "Today", sessions: [] },
    { label: "Previous 7 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of sessions) {
    const at = new Date(session.updatedAt).getTime();
    const group = at >= today ? groups[0] : at >= weekAgo ? groups[1] : groups[2];
    group!.sessions.push(session);
  }
  return groups.filter((group) => group.sessions.length > 0);
}
