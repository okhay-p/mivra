import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Opens a URL in the default browser. Failing to (no desktop, say) only means the user opens it themselves. */
export function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Nothing to open it with.
  }
}

/**
 * Reads a secret without echoing it: from the terminal with a hidden prompt, or all of stdin when it's piped.
 * Never from an argument, which would land in shell history and `ps` (ADR-013).
 */
export async function readSecret(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003" || char === "\u0004") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

/** Asks a yes/no question and reads one line. Anything but y or yes, including no answer at all, is a no. */
export async function confirm(question: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stderr): Promise<boolean> {
  output.write(question);
  const lines = createInterface({ input, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    lines.once("line", resolve);
    lines.once("close", () => resolve(""));
  });
  lines.close();
  input.pause();
  if (!input.isTTY) output.write("\n");
  return /^(y|yes)$/i.test(answer.trim());
}
