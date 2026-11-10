import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { downloadVaultExport } from "./api.js";

/**
 * Downloads what Mivra knows as an Obsidian vault folder (ADR-014): concepts and memories as linked notes, to unzip
 * into the learner's own vault. Their notes aren't in it, and importing the vault again skips these files.
 */
export function ExportVault() {
  const [state, setState] = useState<{ step: "idle" | "busy" } | { step: "done"; filename: string } | { step: "error"; error: string }>({ step: "idle" });
  const run = async () => {
    setState({ step: "busy" });
    const result = await downloadVaultExport();
    setState(result.ok ? { step: "done", filename: result.filename } : { step: "error", error: result.error });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Button type="button" variant="outline" className="self-start" disabled={state.step === "busy"} onClick={() => void run()}>
        {state.step === "busy" ? <Spinner aria-hidden="true" /> : <Download aria-hidden="true" />}
        Export to Obsidian
      </Button>
      <p className="text-muted-foreground text-sm" role="status">
        {state.step === "done"
          ? `Downloaded ${state.filename}. Unzip it into your vault: it adds a Mivra folder of concepts and memories that link to your notes.`
          : "Concepts and memories as linked notes, for your Obsidian vault. Your own notes aren't included."}
      </p>
      {state.step === "error" && <p className="text-destructive text-sm">{state.error}</p>}
    </div>
  );
}
