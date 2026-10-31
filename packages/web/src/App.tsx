import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ArtifactView } from "@mivra/protocol";
import { Brain, MessageSquare, Plus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, authHeaders, errorMessage, loadMessages, token } from "./api.js";
import { ArtifactPart } from "./artifacts/ArtifactPart.js";
import { artifactData, artifactViewsIn, isReplyInProgress, mergeViews } from "./chat-artifacts.js";
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
          <SessionLoader key={activeId} sessionId={activeId} onReply={refreshSessions} />
        ) : (
          <Notice>Start a new session to begin learning.</Notice>
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
  onOpenMemory,
}: {
  sessions: Session[];
  activeId: string | undefined;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
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
                    <MessageSquare />
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

function SessionLoader({ sessionId, onReply }: { sessionId: string; onReply: () => void }) {
  const [initial, setInitial] = useState<UIMessage[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void loadMessages(sessionId).then((result) => (result.ok ? setInitial(result.messages) : setError(result.error)));
  }, [sessionId]);

  if (error) return <Notice error>Couldn't load this session: {error}</Notice>;
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
    const result = await loadMessages(sessionId);
    if (result.ok) setUpdatedViews((prev) => mergeViews(prev, artifactViewsIn(result.messages)));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    void sendMessage({ text });
    setInput("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
          {messages.map((m, mi) => (
            <div
              key={m.id}
              className={cn(
                "flex min-w-0 flex-col gap-2 whitespace-pre-wrap wrap-anywhere",
                m.role === "user" && "bg-primary text-primary-foreground max-w-[80%] self-end rounded-lg rounded-br-sm px-3 py-2",
              )}
            >
              {m.parts.map((part, i) => {
                if (part.type === "text") return <p key={i}>{part.text}</p>;
                if (part.type === "data-artifact") {
                  return (
                    <ArtifactPart
                      key={part.id ?? i}
                      data={artifactData(part, updatedViews)}
                      replyInProgress={isReplyInProgress(status, mi, messages.length)}
                      onUpdate={(view) => setUpdatedViews((prev) => mergeViews(prev, { [view.id]: view }))}
                      onRefresh={refreshViews}
                    />
                  );
                }
                return null;
              })}
            </div>
          ))}
          {status === "submitted" && <p className="text-muted-foreground">Thinking…</p>}
          {error && <p className="text-destructive">{readableError(error)}</p>}
          <div ref={bottom} />
        </div>
      </div>
      <form onSubmit={submit} className="border-t">
        <div className="mx-auto flex max-w-3xl gap-2 p-3">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What do you want to learn?"
            aria-label="Message"
            autoFocus
          />
          <Button type="submit" disabled={busy || !input.trim()}>
            Send
          </Button>
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
