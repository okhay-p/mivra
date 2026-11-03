import { useStickToBottom } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ArtifactView } from "@mivra/protocol";
import { Brain, GraduationCap, MessageSquare, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, authHeaders, errorMessage, loadMessages, token } from "./api.js";
import { ArtifactPart } from "./artifacts/ArtifactPart.js";
import { artifactData, artifactViewsIn, isReplyInProgress, mergeViews } from "./chat-artifacts.js";
import { CourseBar, StartCourseForm, type StartedCourse } from "./Course.js";
import { AttachButton, DocumentChips, useDocuments } from "./Documents.js";
import { ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { MathText } from "./MathText.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { useTheme, type ThemeChoice } from "./theme.js";
import { groupSessions } from "./session-groups.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

interface Session {
  id: string;
  title: string;
  updatedAt: string;
  courseId: string | null;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  // The goal of a course just started, sent as its session's first message so the interview begins.
  const [firstMessage, setFirstMessage] = useState<{ sessionId: string; text: string }>();

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

  const startedCourse = ({ session, goal }: StartedCourse) => {
    setSessions((prev) => [session, ...prev]);
    setFirstMessage({ sessionId: session.id, text: goal });
    setActiveId(session.id);
  };

  const active = sessions.find((s) => s.id === activeId);
  // Lives here because the mobile sidebar unmounts its content when closed, and the theme must keep following the OS.
  const [theme, setTheme] = useTheme();
  // Lives here for the same reason: it has to stay open after the mobile sidebar closes.
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <SidebarProvider>
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        theme={theme}
        onThemeChange={setTheme}
        onSelect={setActiveId}
        onNew={newSession}
        onNewCourse={() => setActiveId(undefined)}
        onOpenMemory={() => setMemoryOpen(true)}
      />
      <MemoryPanel open={memoryOpen} onOpenChange={setMemoryOpen} />
      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-13 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <h1 className="truncate text-base font-medium">{active?.title ?? "Mivra"}</h1>
        </header>
        {!token ? (
          <Notice error>No API token found. Start the server, then reload this page.</Notice>
        ) : error ? (
          <Notice error>{error}</Notice>
        ) : activeId ? (
          <SessionLoader
            key={activeId}
            sessionId={activeId}
            course={Boolean(active?.courseId)}
            firstMessage={firstMessage?.sessionId === activeId ? firstMessage.text : undefined}
            onFirstMessageSent={() => setFirstMessage(undefined)}
            onReply={refreshSessions}
          />
        ) : (
          <StartCourseForm onStarted={startedCourse} onFreeChat={newSession} />
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}

function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p className={cn("m-auto p-6 text-center", error ? "text-destructive" : "text-muted-foreground")}>{children}</p>;
}

function SessionSidebar({
  sessions,
  activeId,
  theme,
  onThemeChange,
  onSelect,
  onNew,
  onNewCourse,
  onOpenMemory,
}: {
  sessions: Session[];
  activeId: string | undefined;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewCourse: () => void;
  onOpenMemory: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  // On mobile the sidebar is an overlay, so close it once the choice is made.
  const closeOnMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 p-1">
          <div className="bg-sidebar-primary text-sidebar-primary-foreground font-heading grid size-6 shrink-0 place-items-center rounded-md text-sm font-semibold">
            M
          </div>
          <span className="font-heading truncate text-base font-semibold group-data-[collapsible=icon]:hidden">Mivra</span>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              tooltip="New session"
              onClick={() => {
                onNew();
                closeOnMobile();
              }}
            >
              <Plus />
              <span>New session</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="New course"
              onClick={() => {
                onNewCourse();
                closeOnMobile();
              }}
            >
              <GraduationCap />
              <span>New course</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {groupSessions(sessions).map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.sessions.map((s) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton
                    isActive={s.id === activeId}
                    tooltip={s.title}
                    onClick={() => {
                      onSelect(s.id);
                      closeOnMobile();
                    }}
                  >
                    {s.courseId ? <GraduationCap aria-label="Course" /> : <MessageSquare />}
                    <span>{s.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Memory"
              data-memory-trigger
              onClick={() => {
                onOpenMemory();
                closeOnMobile();
              }}
            >
              <Brain />
              <span>Memory</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle choice={theme} onChange={onThemeChange} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

interface SessionProps {
  sessionId: string;
  /** Whether the session teaches a course, which shows the course bar. */
  course: boolean;
  /** Sent once, as soon as the empty session opens. */
  firstMessage?: string;
  onFirstMessageSent: () => void;
  onReply: () => void;
}

function SessionLoader({ sessionId, onReply, ...props }: SessionProps) {
  const [initial, setInitial] = useState<UIMessage[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void loadMessages(sessionId).then((result) => (result.ok ? setInitial(result.messages) : setError(result.error)));
  }, [sessionId]);

  if (error) return <Notice error>Couldn't load this session: {error}</Notice>;
  return initial ? <Chat sessionId={sessionId} initialMessages={initial} onReply={onReply} {...props} /> : null;
}

function Chat({
  sessionId,
  initialMessages,
  course,
  firstMessage,
  onFirstMessageSent,
  onReply,
}: SessionProps & { initialMessages: UIMessage[] }) {
  // Bumped after each reply, so the course bar picks up a syllabus written in it.
  const [courseVersion, setCourseVersion] = useState(0);
  const [input, setInput] = useState("");
  const documents = useDocuments(sessionId);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  // Views the learner changed locally (e.g. a graded check), by artifact id. They win over the view in
  // the message part, so the change survives re-renders; a reload gets it from the server instead.
  const [updatedViews, setUpdatedViews] = useState<Record<string, ArtifactView>>({});
  // Immediate container-only scrolling also respects reduced motion on load and during streaming.
  const conversation = useStickToBottom({ initial: "instant", resize: "instant" });
  const stopRequested = useRef(false);
  const messageInput = useRef<HTMLInputElement>(null);
  const [stopError, setStopError] = useState<string>();
  const [continuationFailure, setContinuationFailure] = useState<string>();
  const continuationStopId = useRef<string | undefined>(undefined);
  const continuationResponse = useRef(false);
  const checkVersion = useRef(0);
  const reconnecting = useRef(false);
  const checking = useRef(false);
  const pendingCheck = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const { messages, sendMessage, setMessages, status, error, resumeStream, stop } = useChat({
    id: sessionId,
    experimental_throttle: 50,
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `/api/sessions/${sessionId}/chat`,
      headers: authHeaders,
      prepareReconnectToStreamRequest: () => ({ api: `/api/sessions/${sessionId}/continuation` }),
      // Only files ready when Send is pressed travel with this message; extraction may finish later.
      prepareSendMessagesRequest: ({ messages, body }) => ({ body: { ...body, message: messages.at(-1) } }),
      fetch: async (url, options) => {
        const expected = generation.current;
        const response = await fetch(url, options);
        if (options?.method === "GET") {
          continuationStopId.current = response.headers.get("x-mivra-continuation-stop-id") ?? undefined;
          continuationResponse.current = response.status === 200;
          if (continuationResponse.current) pendingCheck.current = false;
          if (response.status === 204) await reconcile(expected);
          checking.current = false;
          const failure = response.headers.get("x-mivra-continuation-error");
          if (failure) {
            setContinuationFailure(failure);
            if (response.status === 204) throw new Error(failure);
          }
        } else if (response.ok) {
          // Bindings come from acceptance on the server, including during a long-running reply.
          await documentsRef.current.refresh();
        }
        return response;
      },
    }),
    onFinish: ({ message, isDisconnect }) => {
      if (reconnecting.current || isDisconnect || !mounted.current) return;
      if (continuationResponse.current) {
        continuationResponse.current = false;
        continuationStopId.current = undefined;
        void reconcile(generation.current);
      } else if (stopRequested.current) {
        // Reconcile with the durable result: Stop may race a naturally completed reply.
        // A late reload must never overwrite a new turn the learner has already sent.
        void loadMessages(sessionId).then((result) => {
          if (result.ok) setMessages((previous) => previous.at(-1)?.id === message.id ? result.messages : previous);
        });
      }
      onReply();
    },
  });

  const firstSent = useRef(false);
  useEffect(() => {
    if (!firstMessage || firstSent.current || initialMessages.length > 0) return;
    firstSent.current = true;
    onFirstMessageSent();
    void sendMessage({ text: firstMessage }, { body: { documentIds: [] } });
  }, [firstMessage, initialMessages.length, onFirstMessageSent, sendMessage]);

  useEffect(() => {
    const scroll = conversation.scrollRef.current;
    if (!scroll) return;
    scroll.dataset.testid = "transcript";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "Conversation messages");
    // The library escapes wheel input eagerly, but its resize guard can swallow touch/keyboard
    // scroll events during streaming. Use its escape API on upward intent, without cancelling
    // native scrolling or writing scrollTop.
    let touchStart: { x: number; y: number } | undefined;
    const startTouch = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStart = touch ? { x: touch.clientX, y: touch.clientY } : undefined;
    };
    const moveTouch = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touchStart || !touch || scroll.scrollTop <= 0) return;
      const dy = touch.clientY - touchStart.y;
      if (dy > 8 && dy > Math.abs(touch.clientX - touchStart.x)) conversation.stopScroll();
    };
    const scrollKey = (event: KeyboardEvent) => {
      if (event.target === scroll && (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))) {
        conversation.stopScroll();
      }
    };
    scroll.addEventListener("touchstart", startTouch, { passive: true });
    scroll.addEventListener("touchmove", moveTouch, { passive: true });
    scroll.addEventListener("keydown", scrollKey);
    return () => {
      scroll.removeEventListener("touchstart", startTouch);
      scroll.removeEventListener("touchmove", moveTouch);
      scroll.removeEventListener("keydown", scrollKey);
    };
  }, [conversation.scrollRef, conversation.stopScroll]);

  useEffect(() => {
    // An artifact interaction pauses following before its layout changes. If it still fits at the
    // bottom afterwards, re-arm following without moving it; the continuation can then grow normally.
    const frame = requestAnimationFrame(() => {
      const scroll = conversation.scrollRef.current;
      if (scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1) {
        void conversation.scrollToBottom("instant");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [updatedViews, conversation.scrollRef, conversation.scrollToBottom]);

  // The SDK replays chunks into its normal state, including reasoning, artifacts and errors.
  // Focus/visibility deliberately replace a possibly stalled subscription; only the Stop endpoint
  // cancels the server-owned run. There is no idle timer or periodic fallback.
  const busy = status === "submitted" || status === "streaming";
  // A syllabus is written during a reply, often an automatic one, so reload the course bar whenever the
  // chat settles or the transcript is reconciled with the server.
  useEffect(() => {
    if (course && !busy) setCourseVersion((v) => v + 1);
  }, [course, busy, messages.length]);
  const chatState = useRef({ busy, resumeStream, stop });
  chatState.current = { busy, resumeStream, stop };
  async function reconcile(expected: number) {
    const result = await loadMessages(sessionId);
    if (result.ok && mounted.current && generation.current === expected) setMessages(result.messages);
  }
  const checkContinuation = async (afterAnswer = false) => {
    if (checking.current) {
      // A saved answer can overtake an older empty check. Replay that trigger after it settles.
      if (afterAnswer) pendingCheck.current = true;
      return;
    }
    if (chatState.current.busy && !continuationStopId.current) return;
    checking.current = true;
    const version = ++checkVersion.current;
    const expected = generation.current;
    try {
      if (continuationStopId.current) {
        reconnecting.current = true;
        await chatState.current.stop();
        reconnecting.current = false;
      }
      if (!mounted.current || generation.current !== expected) return;
      checking.current = true;
      stopRequested.current = false;
      await chatState.current.resumeStream();
    } finally {
      if (checkVersion.current === version) {
        checking.current = false;
        if (pendingCheck.current && mounted.current) {
          pendingCheck.current = false;
          void checkRef.current();
        }
      }
      reconnecting.current = false;
    }
  };
  const checkRef = useRef(checkContinuation);
  checkRef.current = checkContinuation;
  useEffect(() => {
    mounted.current = true;
    const check = () => { if (document.visibilityState === "visible") void checkRef.current(); };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  const refreshViews = async () => {
    const result = await loadMessages(sessionId);
    if (result.ok) setUpdatedViews((prev) => mergeViews(prev, artifactViewsIn(result.messages)));
    // The attempt may have succeeded even when its response was lost.
    void checkContinuation(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    stopRequested.current = false;
    setStopError(undefined);
    setContinuationFailure(undefined);
    generation.current++;
    checkVersion.current++;
    pendingCheck.current = false;
    // An idle resume check can still be in flight when Send is pressed.
    reconnecting.current = true;
    await stop();
    checking.current = false;
    reconnecting.current = false;
    continuationResponse.current = false;
    continuationStopId.current = undefined;
    void conversation.scrollToBottom("instant");
    const documentIds = documents.documents.filter(d => d.messageId === null).map(d => d.id);
    void sendMessage({ text }, { body: { documentIds } });
    setInput("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {course && <CourseBar sessionId={sessionId} version={courseVersion} />}
      <Conversation aria-busy={busy} instance={conversation} initial="instant" resize="instant" className="min-h-0 min-w-0">
        {/* Positioned, so sr-only artifact text cannot stretch or scroll the outer interface. */}
        <ConversationContent className="relative mx-auto max-w-3xl gap-4 p-4"
          scrollClassName="overflow-y-auto overscroll-contain [scrollbar-gutter:auto]!"
          onPointerDownCapture={(e) => {
            if ((e.target as HTMLElement).closest("button, input, [role=button]")) conversation.stopScroll();
          }}
          onKeyDownCapture={(e) => {
            if (e.key !== "Tab" && (e.target as HTMLElement).closest("button, input, [role=region]")) conversation.stopScroll();
          }}>

          {messages.map((m, mi) => (
            <div
              key={m.id}
              data-message-id={m.id}
              data-message-role={m.role}
              className={cn(
                "flex min-w-0 flex-col gap-2",
                m.role === "user" && "bg-primary text-primary-foreground max-w-[80%] self-end rounded-lg rounded-br-sm px-3 py-2 whitespace-pre-wrap wrap-anywhere",
              )}
            >
              {m.role === "user" && <DocumentChips documents={documents} messageId={m.id} />}
              {m.role === "assistant" && m.parts.some((p) => p.type === "reasoning" && p.text.length > 0) && (
                <ChainOfThought defaultOpen={false}>
                  <ChainOfThoughtHeader>
                    Thinking
                    {isReplyInProgress(status, mi, messages.length) && m.parts.some((p) => p.type === "reasoning" && p.state === "streaming") &&
                      <span className="ml-2 text-xs">In progress…</span>}
                  </ChainOfThoughtHeader>
                  <ChainOfThoughtContent>
                    {m.parts.map((part, index) => part.type === "reasoning" && (
                      <ChainOfThoughtStep key={index} label={<span className="whitespace-pre-wrap">{part.text}</span>}
                        status={isReplyInProgress(status, mi, messages.length) && part.state === "streaming" ? "active" : "complete"} />
                    ))}
                  </ChainOfThoughtContent>
                </ChainOfThought>
              )}
              {m.parts.map((part, i) => {
                if (part.type === "text") return m.role === "user" ? <p key={i}>{part.text}</p> : <MathText key={i} text={part.text} />;
                if (part.type === "data-artifact") {
                  return (
                    <ArtifactPart
                      key={part.id ?? i}
                      data={artifactData(part, updatedViews)}
                      replyInProgress={isReplyInProgress(status, mi, messages.length)}
                      onUpdate={(view) => {
                        setUpdatedViews((prev) => mergeViews(prev, { [view.id]: view }));
                        void checkContinuation(true);
                      }}
                      onRefresh={refreshViews}
                    />
                  );
                }
                return null;
              })}
            </div>
          ))}
          {status === "submitted" && <p className="text-muted-foreground">Thinking…</p>}
          {stopError && <p className="text-destructive">{stopError}</p>}
          {(error || continuationFailure) && <p className="text-destructive">{error ? readableError(error) : continuationFailure}</p>}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to bottom" onClick={() => void conversation.scrollToBottom("instant")} />
      </Conversation>
      <form onSubmit={submit} className="border-t">
        <DocumentChips documents={documents} />
        <div className="mx-auto flex max-w-3xl gap-2 p-3">
          <AttachButton documents={documents} />
          <Input
            ref={messageInput}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What do you want to learn?"
            aria-label="Message"
            autoFocus
          />
          {busy ? (
            <Button type="button" variant="secondary" onClick={async (event) => {
              const stopButton = event.currentTarget;
              const restoreFocus = document.activeElement === stopButton;
              try {
                if (stopRequested.current) return;
                stopRequested.current = true;
                const messageId = continuationStopId.current ?? messages.findLast((message) => message.role === "user")?.id;
                if (!messageId) return;
                const result = await api.sessions[":id"].stop.$post({ param: { id: sessionId }, json: { messageId } });
                // Disabling Send can blur Stop before this request resolves. Restore only
                // its focus, and leave any element the learner moved to alone.
                if (result.ok && restoreFocus && (document.activeElement === stopButton || document.activeElement === document.body)) {
                  messageInput.current?.focus();
                }
                if (!result.ok) stopRequested.current = false;
                if (!result.ok) setStopError("Couldn’t stop the reply. Try again.");
              } catch { stopRequested.current = false; setStopError("Couldn’t stop the reply. Try again."); }
            }}>Stop</Button>
          ) : (
            <Button type="submit" disabled={!input.trim()}>Send</Button>
          )}
        </div>
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
