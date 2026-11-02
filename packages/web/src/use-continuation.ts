import type { UIMessage, ChatStatus } from "ai";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "./api.js";

type Activity = { continuation: boolean; running?: boolean; streaming?: boolean; messageId?: string; runId?: string; error?: string; messages?: UIMessage[] };

/** Observe the server-owned continuation in every tab, including after a lost grading response. */
export function useContinuation(sessionId: string, status: ChatStatus, setMessages: (messages: UIMessage[]) => void) {
  const [activity, setActivity] = useState<Activity>({ continuation: false });
  const epoch = useRef(0);
  useEffect(() => {
    if (status === "submitted" || status === "streaming") return;
    let stale = false;
    let previousMessages = "";
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const started = epoch.current;
      let running = false;
      try {
        const response = await fetch(`/api/sessions/${sessionId}/activity`, { headers: authHeaders });
        if (!response.ok) return;
        const next = await response.json() as Activity;
        if (stale || started !== epoch.current) return;
        running = next.running ?? false;
        if (next.continuation && next.messages) {
          const serialized = JSON.stringify(next.messages);
          if (serialized !== previousMessages) setMessages(next.messages);
          previousMessages = serialized;
        }
        setActivity(({ messages: _, ...previous }) => {
          const { messages: __, ...state } = next;
          return JSON.stringify(previous) === JSON.stringify(state) ? previous : state;
        });
      } catch {
        // A transient polling failure is retried; it doesn't erase the draft or transcript.
      } finally {
        if (!stale) timer = setTimeout(() => void poll(), running ? 100 : 600);
      }
    };
    void poll();
    return () => { stale = true; clearTimeout(timer); };
  }, [sessionId, status, setMessages]);
  return { ...activity, beforeSend: () => { epoch.current++; setActivity({ continuation: false }); } };
}
