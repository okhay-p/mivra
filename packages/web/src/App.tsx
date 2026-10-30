import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ArtifactView } from "@mivra/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, authHeaders, errorMessage, loadMessages, token } from "./api.js";
import { ArtifactPart } from "./artifacts/ArtifactPart.js";
import { artifactData, artifactViewsIn, isReplyInProgress } from "./chat-artifacts.js";

interface Session {
  id: string;
  title: string;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();

  const refreshSessions = async () => {
    try {
      const res = await api.sessions.$get();
      if (!res.ok) return setError(await errorMessage(res));
      setSessions(await res.json());
      setError(undefined);
    } catch {
      setError("Can't reach the Mivra server.");
    }
  };

  useEffect(() => {
    void refreshSessions();
  }, []);

  const newSession = async () => {
    try {
      const res = await api.sessions.$post({ json: {} });
      if (!res.ok) return setError(await errorMessage(res));
      const session = await res.json();
      setSessions((prev) => [session, ...prev]);
      setActiveId(session.id);
    } catch {
      setError("Can't reach the Mivra server.");
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Mivra</h1>
        <button className="new" onClick={newSession}>
          + New session
        </button>
        <ul>
          {sessions.map((s) => (
            <li key={s.id}>
              <button className={s.id === activeId ? "active" : ""} onClick={() => setActiveId(s.id)}>
                {s.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main>
        {!token ? (
          <p className="empty error">No API token found. Start the server, then reload this page.</p>
        ) : error ? (
          <p className="empty error">{error}</p>
        ) : activeId ? (
          <SessionLoader key={activeId} sessionId={activeId} onReply={refreshSessions} />
        ) : (
          <p className="empty">Start a new session to begin learning.</p>
        )}
      </main>
    </div>
  );
}

function SessionLoader({ sessionId, onReply }: { sessionId: string; onReply: () => void }) {
  const [initial, setInitial] = useState<UIMessage[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.sessions[":id"].messages
      .$get({ param: { id: sessionId } })
      .then(async (res) => {
        if (res.ok) setInitial((await res.json()) as UIMessage[]);
        else setError(await errorMessage(res));
      })
      .catch(() => setError("Can't reach the Mivra server."));
  }, [sessionId]);

  if (error) return <p className="empty error">Couldn't load this session: {error}</p>;
  return initial ? <Chat sessionId={sessionId} initialMessages={initial} onReply={onReply} /> : null;
}

function Chat({
  sessionId,
  initialMessages,
  onReply,
}: {
  sessionId: string;
  initialMessages: UIMessage[];
  onReply: () => void;
}) {
  const [input, setInput] = useState("");
  // Views the learner changed locally (e.g. a graded check), by artifact id. They win over the view in
  // the message part, so the change survives re-renders; a reload gets it from the server instead.
  const [updatedViews, setUpdatedViews] = useState<Record<string, ArtifactView>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, status, error } = useChat({
    id: sessionId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `/api/sessions/${sessionId}/chat`,
      headers: authHeaders,
      // The server owns history, so send only the new message.
      prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
    }),
    onFinish: onReply,
  });

  // Block body: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  const refreshViews = async () => {
    const messages = await loadMessages(sessionId);
    if (messages) setUpdatedViews((prev) => ({ ...prev, ...artifactViewsIn(messages) }));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput("");
  };

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m, mi) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === "text") return <p key={i}>{part.text}</p>;
              if (part.type === "data-artifact") {
                return (
                  <ArtifactPart
                    key={part.id ?? i}
                    data={artifactData(part, updatedViews)}
                    replyInProgress={isReplyInProgress(status, mi, messages.length)}
                    onUpdate={(view) => setUpdatedViews((prev) => ({ ...prev, [view.id]: view }))}
                    onRefresh={refreshViews}
                  />
                );
              }
              return null;
            })}
          </div>
        ))}
        {status === "submitted" && <div className="message assistant pending">Thinking…</div>}
        {error && <div className="error">{readableError(error)}</div>}
        <div ref={bottom} />
      </div>
      <form onSubmit={submit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What do you want to learn?"
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

/** The transport surfaces the raw response body; unwrap the server's `{ error }` JSON when present. */
function readableError(error: Error): string {
  try {
    const body = JSON.parse(error.message) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return error.message;
}
