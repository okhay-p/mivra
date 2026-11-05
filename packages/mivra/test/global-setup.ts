import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The tests run the built package, as `npx mivra` would; build it (and the web UI it ships, if missing) first. */
export default function setup() {
  const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  if (!existsSync(at("../../web/dist/index.html"))) {
    execFileSync("pnpm", ["--filter", "@mivra/protocol", "build"], { cwd: at("../../.."), stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@mivra/web", "build"], { cwd: at("../../.."), stdio: "inherit" });
  }
  execFileSync(process.execPath, ["build.mjs"], { cwd: at(".."), stdio: "inherit" });
}
