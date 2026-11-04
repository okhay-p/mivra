import { execSync } from "node:child_process";

/** Builds the UI once; every worker's harness serves the same build. */
export default function globalSetup() {
  execSync("pnpm --filter @mivra/web build", { stdio: "inherit" });
}
