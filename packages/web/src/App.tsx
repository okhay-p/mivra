import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api.js";

interface Session {
  id: string;
  title: string;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>();

  const refreshSessions = async () => {
    const res = await api.sessions.$get();
    setSessions(await res.json());
  };

  useEffect(() => {
    void refreshSessions();
  }, []);

  const newSession = async () => {
    const res = await api.sessions.$post({ json: {} });
    const session = await res.json();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
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
        {activeId ? (
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

  useEffect(() => {
    void api.sessions[":id"].messages.$get({ param: { id: sessionId } }).then(async (res) => {
      setInitial(res.ok ? ((await res.json()) as UIMessage[]) : []);
    });
  }, [sessionId]);

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
  const bottom = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, status, error } = useChat({
    id: sessionId,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `/api/sessions/${sessionId}/chat`,
      // The server owns history, so send only the new message.
      prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } }),
    }),
    onFinish: onReply,
  });

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const busy = status === "submitted" || status === "streaming";
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
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.parts.map((part, i) => (part.type === "text" ? <p key={i}>{part.text}</p> : null))}
          </div>
        ))}
        {status === "submitted" && <div className="message assistant pending">Thinking…</div>}
        {error && <div className="error">{error.message}</div>}
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
