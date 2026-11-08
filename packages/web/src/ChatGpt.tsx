import { CHATGPT_USAGE_URL } from "@mivra/protocol";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { ChatGptMark } from "@/components/chatgpt-mark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PROVIDERS_CHANGED, getProviderKeys, markChatGptWelcomed } from "./api.js";

/*
 * ChatGPT plan UI, following OpenAI's Sign in with ChatGPT guidelines (ADR-015): their wording, the approved
 * button format and the ChatGPT mark. The sign-in button keeps OpenAI's black-and-white colours rather than Mivra's
 * theme tokens, as the approved formats require.
 */

/** "Continue with ChatGPT": black with the white mark, or white with the black mark on a dark page. */
export function ContinueWithChatGptButton({ busy, className, ...props }: ComponentProps<"button"> & { busy?: boolean }) {
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex min-h-[45px] w-full max-w-[242px] items-center justify-center gap-3 rounded-[12px] px-5 py-3 text-[15px] font-medium",
        "bg-black text-white hover:opacity-85 active:opacity-70 disabled:opacity-50 dark:bg-white dark:text-black",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
        className,
      )}
      {...props}
    >
      <ChatGptMark />
      {busy ? "Opening ChatGPT…" : "Continue with ChatGPT"}
    </button>
  );
}

/** "Manage usage": ChatGPT's own page for plan usage and this app's limit. */
export function ManageUsageLink({ className, primary = false }: { className?: string; primary?: boolean }) {
  return (
    <Button asChild size={primary ? "sm" : "xs"} variant={primary ? "default" : "link"} className={cn(!primary && "h-auto p-0", className)}>
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer" aria-label="Manage ChatGPT usage (opens in a new tab)">
        Manage usage <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

/** Shown beside the model picker while replies use the learner's plan. */
export function UsingChatGptPlan() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs" aria-live="polite">
      <ChatGptMark className="size-4" />
      Using ChatGPT plan
      <span aria-hidden>·</span>
      <ManageUsageLink />
    </span>
  );
}

/** A reply that failed because the plan's usage limit was reached, with "Manage usage" as the way forward. */
export function UsageLimitNotice() {
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
        <ChatGptMark className="size-4" /> ChatGPT
      </span>
      <p className="font-semibold">Usage limit reached</p>
      <p className="text-muted-foreground">Review your plan or this app's limit in ChatGPT settings.</p>
      <ManageUsageLink primary className="mt-1 self-start" />
    </div>
  );
}

/** The one-time "You're using your ChatGPT plan" dialog, shown the first time the learner signs in. */
export function ChatGptWelcome() {
  const [open, setOpen] = useState(false);

  const look = useCallback(() => {
    void getProviderKeys().then((result) => {
      if (result.ok && result.value.chatgpt?.welcome) setOpen(true);
    });
  }, []);

  useEffect(() => {
    look();
    window.addEventListener(PROVIDERS_CHANGED, look);
    return () => window.removeEventListener(PROVIDERS_CHANGED, look);
  }, [look]);

  const dismiss = () => {
    setOpen(false);
    void markChatGptWelcomed();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center sm:text-center">
          <ChatGptMark className="text-foreground mb-2 size-[72px]" />
          <DialogTitle>You're using your ChatGPT plan</DialogTitle>
          <DialogDescription>Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
