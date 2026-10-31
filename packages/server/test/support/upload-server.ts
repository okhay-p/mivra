import { serve } from "@hono/node-server";
import { createApp } from "../../src/app.js";
import { openDb } from "../../src/db/client.js";

/** The real app in a process of its own, so a test can see an uncaught error kill it. Prints its port and session. */
const app = createApp({
  db: openDb(":memory:"),
  model: () => {
    throw new Error("No model here");
  },
  security: { token: "t", allowedHosts: [] },
});
serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, async (info) => {
  const res = await app.request("/api/sessions", { method: "POST", headers: { authorization: "Bearer t" } });
  console.log(JSON.stringify({ port: info.port, session: ((await res.json()) as { id: string }).id }));
});
