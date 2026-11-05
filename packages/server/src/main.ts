import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { PortInUseError, startServer } from "./start.js";

// Run from the repo (`pnpm start`, `pnpm dev`). Installed copies start through the `mivra` command instead.
// No port fallback here: Vite's dev proxy expects the server on MIVRA_PORT (default 4096).
const config = loadConfig();
try {
  const server = await startServer({ config, webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)) });
  console.log(`Mivra server listening on ${server.url} (data: ${config.dataDir})`);
} catch (error) {
  if (!(error instanceof PortInUseError)) throw error;
  console.error(`${error.message} Stop whatever is using it, or set MIVRA_PORT.`);
  process.exit(1);
}
