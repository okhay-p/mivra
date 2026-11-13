import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { token } from "./api.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Copies a text, and says so. Without clipboard access (plain HTTP on another address) it can be selected by hand. */
function CopyButton({ text, label, onFail }: { text: string; label: string; onFail?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          onFail?.();
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * Settings → Connect a CLI (ADR-016): what `mivra link --server` needs on another computer, so `mivra check` can run
 * there against this Mivra. The token is the one this page already holds to call the API, so showing it gives this
 * browser nothing it didn't have; it's hidden until asked for, against onlookers.
 */
export function ConnectCli() {
  const [shown, setShown] = useState(false);
  const { origin, hostname } = window.location;
  const command = `mivra link --server ${origin}`;
  return (
    <section aria-labelledby="settings-cli" className="flex flex-col gap-2 px-4 pb-4">
      <h3 id="settings-cli" className="font-heading text-base font-medium">Connect a CLI</h3>
      <p className="text-muted-foreground text-sm">
        To check a project course from another computer, install Mivra there and run this in a terminal. Paste the token when it asks; it's saved on
        that computer, never in your repository. The checks run on that computer.
      </p>
      <div className="bg-sunken flex min-w-0 items-center gap-2 rounded-md py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre" data-testid="cli-link-command">{command}</code>
        <CopyButton text={command} label="link command" />
      </div>
      {LOOPBACK.has(hostname) && (
        <p className="text-muted-foreground text-sm">
          Other computers can't reach this address. Use the one they reach Mivra by, such as its <code className="font-mono text-xs">tailscale serve</code>{" "}
          name.
        </p>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Input
          readOnly
          aria-label="Token"
          type={shown ? "text" : "password"}
          value={token}
          className="min-w-0 flex-1 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" size="sm" aria-pressed={shown} aria-label={shown ? "Hide token" : "Show token"} onClick={() => setShown((s) => !s)}>
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
        <CopyButton text={token} label="token" onFail={() => setShown(true)} />
      </div>
      <p className="text-muted-foreground text-sm">
        Anyone with the token can use this Mivra, so keep it private. On the computer running Mivra, <code className="font-mono text-xs">mivra token</code> prints
        it too, and <code className="font-mono text-xs">mivra check</code> there needs no token.
      </p>
    </section>
  );
}
