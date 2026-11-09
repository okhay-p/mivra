#!/usr/bin/env node
// Runs only the Vitest tests affected by what changed since a git ref (default origin/main): the test files that
// import a changed file, directly or not, in every package. `pnpm test:changed [ref]`; see AGENTS.md for when.
import { spawn, spawnSync } from "node:child_process";

const ref = process.argv[2] ?? "origin/main";
const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdio: "ignore" });
if (check.status !== 0) {
  console.error(`"${ref}" isn't a commit here. Usage: pnpm test:changed [ref]`);
  process.exit(2);
}
// Asynchronous, so a signal sent to this process is passed on rather than leaving the tests running.
const child = spawn("pnpm", ["-r", "--filter=!@mivra/e2e", "exec", "vitest", "run", "--changed", ref, "--passWithNoTests"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
