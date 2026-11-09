import { useStickToBottom } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ArtifactView, CourseLessonsView, CourseView, LessonView } from "@mivra/protocol";
import { CHATGPT_USAGE_LIMIT_ERROR } from "@mivra/protocol";
import { Brain, GraduationCap, KeyRound, Library, MessageSquare, MessagesSquare, Plus, SquarePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { addToLesson, undoSyllabusChange, api, authHeaders, errorMessage, getCourse, getProviderKeys, listCourseLessons, loadMessages, startLesson, token } from "./api.js";
import { ArtifactPart } from "./artifacts/ArtifactPart.js";
import { artifactData, artifactViewsIn, isReplyInProgress, mergeViews } from "./chat-artifacts.js";
import { CourseBar, StartCourseForm, type StartedCourse } from "./Course.js";
import { LessonPage, TopicList, type LessonSection } from "./Lesson.js";
import { AttachButton, DocumentChips, useDocuments } from "./Documents.js";
import { ChainOfThought, ChainOfThoughtHeader, ChainOfThoughtContent, ChainOfThoughtStep } from "@/components/ai-elements/chain-of-thought";
import { MathText } from "./MathText.js";
import { ImportsPanel } from "./ImportsPanel.js";
import { MemoryPanel } from "./MemoryPanel.js";
import { ModelPicker, modelLabel, useModelPicker } from "./ModelPicker.js";
import { ProvidersPanel, hasAnyKey } from "./ProvidersPanel.js";
import { ChatGptWelcome, UsageLimitNotice } from "./ChatGpt.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { useTheme, type ThemeChoice } from "./theme.js";
import { groupSessions } from "./session-groups.js";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  const [importsOpen, setImportsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  // With no API key anywhere, the providers panel opens as first-run setup (ADR-013).
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    if (!token) return;
    void getProviderKeys().then((result) => {
      if (result.ok && !hasAnyKey(result.value)) {
        setFirstRun(true);
        setProvidersOpen(true);
      }
    });
  }, []);

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
        onOpenImports={() => setImportsOpen(true)}
        onOpenProviders={() => setProvidersOpen(true)}
      />
      <MemoryPanel open={memoryOpen} onOpenChange={setMemoryOpen} />
      <ImportsPanel open={importsOpen} onOpenChange={setImportsOpen} />
      <ProvidersPanel open={providersOpen} onOpenChange={setProvidersOpen} firstRun={firstRun} />
      <ChatGptWelcome />
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
          <SessionView
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
  onOpenImports,
  onOpenProviders,
}: {
  sessions: Session[];
  activeId: string | undefined;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewCourse: () => void;
  onOpenMemory: () => void;
  onOpenImports: () => void;
  onOpenProviders: () => void;
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
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Imported notes"
              data-imports-trigger
              onClick={() => {
                onOpenImports();
                closeOnMobile();
              }}
            >
              <Library />
              <span>Imported notes</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Model providers"
              data-providers-trigger
              onClick={() => {
                onOpenProviders();
                closeOnMobile();
              }}
            >
              <KeyRound />
              <span>Model providers</span>
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
  /** Sent once, as soon as the empty session opens. */
  firstMessage?: string;
  onFirstMessageSent: () => void;
  onReply: () => void;
  /** Called whenever the chat settles after a reply, e.g. to pick up a syllabus written in it. */
  onSettled?: () => void;
  /** The lesson open beside the chat, sent with each message so the tutor knows what the learner sees. */
  lessonId?: string;
  /** Text to put in the message box, sent at once if `send`. Applied once; `onPromptUsed` clears it. */
  prompt?: { text: string; send: boolean; nonce: number };
  onPromptUsed?: () => void;
  /** Offers "Add to lesson" on the tutor's replies. */
  onAddToLesson?: (messageId: string) => Promise<string | undefined>;
  /** Folds away a course's placement interview, up to and including this reply (the one that wrote the syllabus). */
  foldThroughMessageId?: string | null;
  /** The message box's placeholder. */
  placeholder?: string;
}

function SessionView({ course, ...props }: SessionProps & { course: boolean }) {
  return course ? <CourseSession {...props} /> : <SessionLoader {...props} />;
}

/**
 * A course's session (ADR-011): the placement interview runs as a chat; once the first lesson starts,
 * the lesson is the page and the tutor's chat moves into a drawer.
 */
function CourseSession(props: SessionProps) {
  const { sessionId } = props;
  const [course, setCourse] = useState<CourseView>();
  const [lessons, setLessons] = useState<CourseLessonsView>();
  const [selected, setSelected] = useState<string>();
  const [focusSection, setFocusSection] = useState<string>();
  const [tutorOpen, setTutorOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [prompt, setPrompt] = useState<SessionProps["prompt"]>();
  const [openLesson, setOpenLesson] = useState<LessonView>();
  // The section the learner last asked about, where Add to lesson puts the answer.
  const explained = useRef<{ lessonId: string; section: LessonSection } | undefined>(undefined);

  const refresh = useCallback(async () => {
    const found = await getCourse(sessionId);
    if (!found.ok) return setError(found.error);
    setCourse(found.value);
    if (found.value.status === "interviewing") return;
    const list = await listCourseLessons(found.value.id);
    if (list.ok) setLessons(list.value);
  }, [sessionId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async (topicId: string) => {
    if (!course) return;
    const result = await startLesson(course.id, topicId);
    if (!result.ok) return setError(result.error);
    setSelected(result.value.lesson.id);
    await refresh();
  };

  const lessonId = selected ?? lessons?.currentLessonId ?? undefined;
  // The lesson the learner is on: the first unfinished one, if any.
  const current = lessons?.topics.find((t) => t.lesson && t.lesson.id === lessons.currentLessonId && t.lesson.status !== "finished");
  // Ctrl+K (or ⌘K) opens and closes the tutor beside the lesson.
  useEffect(() => {
    if (!lessonId) return;
    const toggle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setTutorOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [lessonId]);

  const ask = (text: string, send: boolean) => {
    setPrompt((p) => ({ text, send, nonce: (p?.nonce ?? 0) + 1 }));
    setTutorOpen(true);
  };
  const addAnswer = async (messageId: string) => {
    if (!lessonId) return "No lesson is open.";
    // The section last asked about, if it's still in the open lesson; otherwise the lesson's last section.
    const asked =
      explained.current?.lessonId === lessonId && openLesson?.id === lessonId && openLesson.sections.some((s) => s.id === explained.current!.section.id)
        ? explained.current.section
        : undefined;
    const after = asked ?? (openLesson?.id === lessonId ? openLesson.sections.at(-1) : undefined);
    const result = await addToLesson(lessonId, {
      messageId,
      afterSectionId: after?.id ?? null,
      title: asked ? `More on ${asked.title}`.slice(0, 120) : "From the tutor",
    });
    if (!result.ok) return result.error;
    setOpenLesson(result.value.lesson);
    return undefined;
  };

  // Generation can change the syllabus while the learner reads (ADR-011); the lesson view says so.
  const shownSyllabus = course?.syllabus?.version;
  const lessonSyllabus = openLesson?.syllabusVersion;
  useEffect(() => {
    if (lessonSyllabus && shownSyllabus && lessonSyllabus !== shownSyllabus) void refresh();
  }, [lessonSyllabus, shownSyllabus, refresh]);

  const undo = async () => {
    if (!course?.syllabus) return undefined;
    const result = await undoSyllabusChange(course.id, course.syllabus.version);
    if (!result.ok) return result.error;
    await refresh();
    return undefined;
  };

  if (error) return <Notice error>{error}</Notice>;
  if (!course) return null;
  const next = lessons?.topics.find((t) => t.topicId === lessons.nextTopicId);

  if (!lessonId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <CourseBar course={course}>
          {next && (
            <Button size="sm" onClick={() => void start(next.topicId)}>
              Start lesson 1
            </Button>
          )}
        </CourseBar>
        <SessionLoader {...props} onSettled={refresh} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CourseBar course={course} onUndo={undo}>
        <Button size="sm" variant="outline" onClick={() => setTutorOpen(true)} data-tutor-trigger>
          <MessagesSquare aria-hidden /> Tutor
        </Button>
      </CourseBar>
      <div className="flex min-h-0 flex-1">
        {lessons && (
          <aside className="hidden w-60 shrink-0 overflow-y-auto border-r p-3 md:block">
            <TopicList
              lessons={lessons}
              selectedId={lessonId}
              onSelect={(id) => {
                setFocusSection(undefined);
                setSelected(id);
              }}
            />
          </aside>
        )}
        <div className="min-w-0 flex-1 overflow-y-auto" data-testid="lesson-scroll">
          {lessons && (
            <details className="border-b px-4 py-2 md:hidden">
              <summary className="cursor-pointer text-sm font-medium">Lessons</summary>
              <div className="pt-2">
                <TopicList
                  lessons={lessons}
                  selectedId={lessonId}
                  onSelect={(id) => {
                    setFocusSection(undefined);
                    setSelected(id);
                  }}
                />
              </div>
            </details>
          )}
          {current && lessonId !== current.lesson!.id && (
            <div className="bg-muted mx-auto mt-4 flex max-w-3xl flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-sm" role="status">
              <span>You're looking at an earlier lesson.</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setFocusSection(undefined);
                  setSelected(current.lesson!.id);
                }}
              >
                Back to lesson {lessons!.topics.indexOf(current) + 1}: {current.title}
              </Button>
            </div>
          )}
          <LessonPage
            courseComplete={course.status === "complete"}
            key={lessonId}
            lessonId={lessonId}
            nextTopic={next && { id: next.topicId, title: next.title }}
            onFinished={() => void refresh()}
            onStartNext={start}
            onLoaded={setOpenLesson}
            focusSectionId={focusSection}
            onOpenSection={(id, sectionId) => {
              setSelected(id);
              setFocusSection(sectionId);
            }}
            onExplain={(section) => {
              explained.current = { lessonId, section };
              ask(`Explain "${section.title}"`, true);
            }}
            onChange={(section) => {
              explained.current = undefined;
              ask(`Change "${section.title}": `, false);
            }}
          />
        </div>
      </div>
      <Sheet open={tutorOpen} onOpenChange={setTutorOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle className="font-heading">Tutor</SheetTitle>
            <SheetDescription>
              Ask anything and the lesson stays as it is, or ask for a change. <kbd className="text-xs">Ctrl K</kbd> opens and closes this.
            </SheetDescription>
          </SheetHeader>
          <SessionLoader
            {...props}
            onSettled={refresh}
            lessonId={lessonId}
            prompt={prompt}
            onPromptUsed={() => setPrompt(undefined)}
            foldThroughMessageId={course.interviewMessageId}
            placeholder="Ask the tutor…"
            onAddToLesson={openLesson?.status === "ready" ? addAnswer : undefined}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
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
  firstMessage,
  onFirstMessageSent,
  onReply,
  onSettled,
  lessonId,
  prompt,
  onPromptUsed,
  onAddToLesson,
  foldThroughMessageId,
  placeholder = "What do you want to learn?",
}: SessionProps & { initialMessages: UIMessage[] }) {
  const [showInterview, setShowInterview] = useState(false);
  const lessonRef = useRef(lessonId);
  lessonRef.current = lessonId;
  const [input, setInput] = useState("");
  const documents = useDocuments(sessionId);
  const modelPicker = useModelPicker();
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
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: { ...body, message: messages.at(-1), ...(lessonRef.current ? { lessonId: lessonRef.current } : {}) },
      }),
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

  // A prompt from the lesson page: Explain sends at once, Change waits for the learner to finish it.
  const appliedPrompt = useRef(0);
  useEffect(() => {
    if (!prompt || prompt.nonce === appliedPrompt.current) return;
    appliedPrompt.current = prompt.nonce;
    onPromptUsed?.();
    if (prompt.send && !chatState.current.busy) {
      void sendMessage({ text: prompt.text }, { body: { documentIds: [] } });
    } else {
      setInput(prompt.text);
      requestAnimationFrame(() => messageInput.current?.focus());
    }
  }, [prompt, sendMessage, onPromptUsed]);

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
  // A syllabus is written during a reply, often an automatic one, so tell the course whenever the chat
  // settles or the transcript is reconciled with the server.
  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    if (!busy) settled.current?.();
  }, [busy, messages.length]);
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

  // Messages up to the reply that wrote the syllabus are the placement interview (-1: nothing to fold).
  const interviewEnd = foldThroughMessageId ? messages.findIndex((m) => m.id === foldThroughMessageId) : -1;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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

          {messages.length === 0 && !busy && (
            <Empty className="my-auto">
              <EmptyHeader>
                <EmptyMedia variant="icon"><MessagesSquare aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>Start a conversation</EmptyTitle>
                <EmptyDescription>Ask a question, explore a concept or attach course notes to learn from.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {interviewEnd >= 0 && !showInterview && (
            <Button variant="ghost" size="sm" className="text-muted-foreground self-center" onClick={() => setShowInterview(true)}>
              Show the placement interview
            </Button>
          )}
          {messages.map((m, mi) => (!showInterview && mi <= interviewEnd) ? null : (
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
              {m.role === "assistant" && typeof (m.metadata as { model?: unknown } | undefined)?.model === "string" && (
                <p className="text-muted-foreground text-xs" data-reply-model>
                  {modelLabel((m.metadata as { model: string }).model, modelPicker.view?.models)}
                </p>
              )}
              {onAddToLesson && m.role === "assistant" && mi > interviewEnd && !isReplyInProgress(status, mi, messages.length) && m.parts.some((p) => p.type === "text" && p.text.trim()) && (
                <AddToLessonButton onAdd={() => onAddToLesson(m.id)} />
              )}
            </div>
          ))}
          {status === "submitted" && <p className="text-muted-foreground flex items-center gap-2" role="status"><Spinner aria-hidden="true" /> Thinking…</p>}
          {stopError && <p className="text-destructive">{stopError}</p>}
          {(error || continuationFailure) &&
            ((error ? readableError(error) : continuationFailure) === CHATGPT_USAGE_LIMIT_ERROR ? (
              <UsageLimitNotice />
            ) : (
              <p className="text-destructive">{error ? readableError(error) : continuationFailure}</p>
            ))}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to bottom" onClick={() => void conversation.scrollToBottom("instant")} />
      </Conversation>
      <form onSubmit={submit} className="border-t">
        <DocumentChips documents={documents} />
        <div className="mx-auto w-full max-w-3xl p-3">
          <InputGroup className="h-auto min-h-11" aria-label="Message composer">
            <InputGroupAddon align="inline-start">
              <AttachButton documents={documents} />
            </InputGroupAddon>
            <InputGroupInput
              ref={messageInput}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              aria-label="Message"
              autoFocus
            />
            <InputGroupAddon align="inline-end">
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
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="mx-auto flex max-w-3xl px-3 pb-2">
          <ModelPicker state={modelPicker} />
        </div>
      </form>
    </div>
  );
}

/** Keeps one tutor answer as a section of the open lesson. */
function AddToLessonButton({ onAdd }: { onAdd: () => Promise<string | undefined> }) {
  const [state, setState] = useState<"idle" | "adding" | "added">("idle");
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        disabled={state !== "idle"}
        onClick={async () => {
          setState("adding");
          setError(undefined);
          const failure = await onAdd();
          setError(failure);
          setState(failure ? "idle" : "added");
        }}
      >
        <SquarePlus aria-hidden /> {state === "added" ? "Added to lesson" : "Add to lesson"}
      </Button>
      {error && <span className="text-destructive text-xs">{error}</span>}
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
