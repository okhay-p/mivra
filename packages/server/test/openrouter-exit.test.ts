import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Based on the production disconnect reproducer: real provider, sockets and plain Node,
// isolated from Vitest's rejection handlers. Compile privately so no prior build is needed.
it("survives an OpenRouter socket failure after client disconnect and completes a later turn", async () => {
  const serverDir = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "mivra-openrouter-exit-"));
  const compile = (cwd: string, outDir: string, config = "tsconfig.build.json") => execFileSync("pnpm", ["exec", "tsc", "-p", config, "--outDir", outDir], { cwd, stdio: "pipe" });
  let held: ServerResponse | undefined;
  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({
      id: "fake", object: "chat.completion.chunk", created: 1, model: "fake",
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    })}\n\n`;
    if (!held) {
      held = response;
      response.write(chunk("Partial reply"));
      response.write('data: {"id":"broken');
    } else {
      response.end(chunk("Recovered reply") + chunk("", "stop") + "data: [DONE]\n\n");
    }
  });
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = "";
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    compile(join(serverDir, "../protocol"), join(root, "protocol/dist"));
    writeFileSync(join(root, "protocol/package.json"), JSON.stringify({ type: "module", exports: "./dist/index.js" }));
    const config = join(root, "tsconfig.json");
    writeFileSync(config, JSON.stringify({
      extends: join(serverDir, "tsconfig.build.json"),
      compilerOptions: { paths: { "@mivra/protocol": [join(root, "protocol/dist/index.d.ts")] } },
    }));
    mkdirSync(join(root, "node_modules/@mivra"), { recursive: true });
    for (const name of readdirSync(join(serverDir, "node_modules"))) {
      if (name !== "@mivra") symlinkSync(join(serverDir, "node_modules", name), join(root, "node_modules", name));
    }
    symlinkSync(join(root, "protocol"), join(root, "node_modules/@mivra/protocol"));
    symlinkSync(join(serverDir, "drizzle"), join(root, "drizzle"));
    compile(serverDir, join(root, "dist"), config);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address() as { port: number };
    // Block external requests and redirect only the provider endpoint. No real credentials inherited.
    const preload = join(root, "local-provider.mjs");
    writeFileSync(preload, `
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url ?? input);
        if (url.origin !== 'https://openrouter.ai') throw new Error('External request blocked');
        return original('http://127.0.0.1:${address.port}' + url.pathname, init);
      };
    `);
    child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", preload, "dist/main.js"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, MIVRA_PORT: "0", MIVRA_MODEL: "openrouter:fake", MIVRA_DATA_DIR: join(root, "data"), OPENROUTER_API_KEY: "fake-local-only" },
    });
    child.stderr!.on("data", (data) => (stderr += data));
    const exited = once(child, "exit");
    const died = exited.then(([code]) => { throw new Error(`Production server exited ${code}: ${stderr}`); });
    // Every operation races process exit, so a crash fails immediately instead of timing out.
    await Promise.race([died, (async () => {
      let stdout = "";
      for await (const data of child!.stdout!) {
        stdout += data;
        const port = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
        if (port) return port;
      }
      throw new Error("Server closed stdout before startup");
    })().then(async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const headers = { "content-type": "application/json", authorization: `Bearer ${readFileSync(join(root, "data/auth-token"), "utf8").trim()}` };
      const session = await (await fetch(`${base}/api/sessions`, { method: "POST", headers, body: "{}" })).json() as { id: string };
      const send = (signal?: AbortSignal) => fetch(`${base}/api/sessions/${session.id}/chat`, {
        method: "POST", headers, signal,
        body: JSON.stringify({ message: { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "hello" }] } }),
      });
      const abort = new AbortController();
      const response = await send(abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("Partial reply")) {
        const { value, done } = await reader.read();
        expect(done).toBe(false);
        text += new TextDecoder().decode(value);
      }
      const closed = once(held!, "close");
      abort.abort();
      held!.socket!.destroy();
      await reader.cancel().catch(() => {});
      await closed;
      // The next HTTP round trip also lets Node report any unhandled cancellation rejection.
      const recovered = await send();
      expect(recovered.status).toBe(200);
      const sse = await recovered.text();
      expect(sse).toContain("Recovered reply");
      expect(sse).toContain("data: [DONE]");
      expect(child!.exitCode, stderr).toBeNull();
    })]);
  } catch (error) {
    throw new Error(`OpenRouter disconnect regression failed; child exit: ${child?.exitCode}; stderr: ${stderr}`, { cause: error });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
