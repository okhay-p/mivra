import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CommandError, fillPlaceholders, runProgram, splitCommand, windowsKillScript } from "../src/run-command.js";

const dir = mkdtempSync(join(tmpdir(), "mivra-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const script = (name: string, source: string) => {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
};
const node = process.execPath;
const limits = { timeoutMs: 5_000, maxOutputBytes: 1024 * 1024 };

describe("splitting the learner's command", () => {
  it("splits on spaces and keeps quoted text together, as a shell would", () => {
    expect(splitCommand("./build/mycc {input}", "linux")).toEqual(["./build/mycc", "{input}"]);
    expect(splitCommand(`  python3   "my compiler.py"  --file={input} 'a b'`, "linux")).toEqual(["python3", "my compiler.py", "--file={input}", "a b"]);
    expect(splitCommand(String.raw`./run\ me "say \"hi\"" ''`, "linux")).toEqual(["./run me", 'say "hi"', ""]);
  });

  it("treats backslashes as part of a path on Windows", () => {
    expect(splitCommand(String.raw`.\build\mycc.exe {input}`, "win32")).toEqual([String.raw`.\build\mycc.exe`, "{input}"]);
    expect(splitCommand(String.raw`"C:\Program Files\Python\python.exe" main.py {input}`, "win32")).toEqual([String.raw`C:\Program Files\Python\python.exe`, "main.py", "{input}"]);
    expect(splitCommand("npm run --silent start -- {input}", "win32")).toEqual(["npm", "run", "--silent", "start", "--", "{input}"]);
  });

  it("refuses shell syntax it won't run, rather than pass it on as text", () => {
    for (const command of ["make && ./mycc {input}", "./mycc {input} | sort", "./mycc < {input}", "./mycc $HOME", "./mycc `id`", "a; b", "./mycc $(id)"]) {
      expect(() => splitCommand(command, "linux"), command).toThrow(CommandError);
      expect(() => splitCommand(command, "win32"), command).toThrow(CommandError);
    }
    expect(() => splitCommand(`"unclosed {input}`, "linux")).toThrow(/unclosed double quote/);
    expect(() => splitCommand("   ", "linux")).toThrow(/empty/);
    // Quoted, they're ordinary characters.
    expect(splitCommand(`./mycc "a|b" '$HOME'`, "linux")).toEqual(["./mycc", "a|b", "$HOME"]);
  });

  it("replaces only the placeholders, with the paths Mivra chose", () => {
    const args = splitCommand("./mycc --in={input} {input} {output} literal", "linux");
    expect(fillPlaceholders(args, { input: "/tmp/x y/input" })).toEqual(["./mycc", "--in=/tmp/x y/input", "/tmp/x y/input", "{output}", "literal"]);
    expect(fillPlaceholders(args, { input: "/i", output: "/o" })).toEqual(["./mycc", "--in=/i", "/i", "/o", "literal"]);
  });
});

describe("running the learner's program", () => {
  it("passes the input on stdin and reports what it printed and its exit code", async () => {
    const echo = script("echo.mjs", "let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => { console.log(s.toUpperCase()); console.error('note'); process.exit(3); });");
    const run = await runProgram([node, echo], { cwd: dir, stdin: "abc", limits });
    expect(run).toEqual({ stdout: "ABC\n", stderr: "note\n", exitCode: 3 });
  });

  it("stops a program that hangs, and what it started", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const hang = script(
      "hang.mjs",
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
       writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const run = await runProgram([node, hang], { cwd: dir, stdin: "", limits: { ...limits, timeoutMs: 1_000 } });
    expect(run).toMatchObject({ error: "timeout", exitCode: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    if (process.platform !== "win32") expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("stops what a program left running after it exited", async () => {
    const pidFile = join(dir, "orphan.pid");
    const launcher = script(
      "launcher.mjs",
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.exit(0);`,
    );
    const run = await runProgram([node, launcher], { cwd: dir, stdin: "", limits });
    expect(run.exitCode).toBe(0);
    const orphan = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => { try { process.kill(orphan, 0); return true; } catch { return false; } }, { timeout: 5_000 }).toBe(false);
  });

  it("finds a Windows program's descendants by parent pid and start time, not through a live parent", () => {
    const script = windowsKillScript(4242, new Date("2026-11-13T10:00:00.000Z"));
    expect(script).toContain("[datetime]::Parse('2026-11-13T10:00:00.000Z')");
    expect(script).toContain("$c.ParentProcessId -eq $p");
    expect(script).toContain("CreationDate.ToUniversalTime() -ge $since");
    expect(script).toContain("Stop-Process -Id $i -Force");
  });

  it("stops a program that prints too much", async () => {
    const flood = script("flood.mjs", "const line = 'x'.repeat(1000) + '\\n'; const go = () => { while (process.stdout.write(line)); process.stdout.once('drain', go); }; go();");
    const run = await runProgram([node, flood], { cwd: dir, stdin: "", limits: { timeoutMs: 10_000, maxOutputBytes: 100_000 } });
    expect(run.error).toBe("output_limit");
    expect(run.stdout.length).toBeLessThanOrEqual(100_000);
  });

  it("says when the program can't start", async () => {
    const run = await runProgram([join(dir, "no-such-program")], { cwd: dir, stdin: "", limits });
    expect(run).toMatchObject({ error: "start_failed", exitCode: null });
    expect(run.startError).toMatch(/ENOENT/);
  });
});
