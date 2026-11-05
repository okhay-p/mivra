# Mivra

An open-source, local-first AI agent harness for learning. Decisions live in [`docs/adr/`](docs/adr/README.md); longer design docs and the backlog live in the [Mivra Project HQ](https://app.notion.com/p/408fb102b9b68185823dc5c90dc17f7f) Notion space.

## Layout

| Package | What it is |
|---|---|
| `packages/server` | Hono API server (Node.js). Owns the agent runtime, the SQLite database (Drizzle + better-sqlite3) and model access (Vercel AI SDK). Binds to `127.0.0.1` only. |
| `packages/web` | React + Vite web UI (shadcn/ui on Tailwind v4). Talks to the server only through its API. |
| `packages/protocol` | Versioned Zod schemas for learning artifacts (`algorithm_trace`, `set_diagram`, `graph`, `multiple_choice`, `table`, `worked_steps`), their tool definitions and the deterministic grader. Shared by server and web. |

## Setup

Requires Node.js 22.14+ and pnpm 10 (`npm i -g pnpm`, or prefix commands with `npx pnpm@10`).

```sh
pnpm install
```

Models run through [OpenRouter](https://openrouter.ai), Anthropic or OpenAI, so one API key is the only setting needed: an OpenRouter key reaches every model, while Anthropic and OpenAI keys call those providers directly. Add a key in the app under **Model providers** in the sidebar, which opens by itself while no key is set. Keys saved there go in `credentials.json` in the data dir (mode 0600), never in the database, and are never sent back to the browser; **Check** asks the provider whether it accepts the key, without spending tokens. Only a browser on the computer running Mivra can change keys: requests through a proxy such as `tailscale serve` see them read-only (ADR-013). `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment or `.env` (see `.env.example`) still work and take precedence over saved keys. A new or removed key applies from the next reply, without a restart. Until you choose a model, a new install uses GPT-6 Luna at high effort: through OpenRouter if its key is set, otherwise through OpenAI. With only an Anthropic key, it uses Claude Sonnet 5.5 (ADR-012). `MIVRA_MODEL` and `MIVRA_REASONING_EFFORT` are no longer read, and the server warns at startup if they're still set.

The picker under the message box chooses the model and reasoning effort for every later reply, syllabus and lesson; a reply already streaming keeps its model. It lists the models that can call tools, which Mivra's learning tools need, from each provider whose key is set, plus the default model. OpenRouter's public list describes every model (name, price, effort levels and tool support), so Anthropic's and OpenAI's own models appear only when OpenRouter lists their counterpart. The lists refresh hourly, and a saved copy is used offline. Search results are grouped by provider, and a model called directly shows its provider next to its name. Opened, it shows your pinned and recent models and a few suggestions; typing searches the whole list. The star pins the current model. The effort menu shows only the levels the selected model supports. Each reply names the model that wrote it, and each run records its model and effort. Reasoning details from earlier replies go back only to the model that wrote them, so after a switch the new model sees earlier replies as text.

## Native dependency

`better-sqlite3` ships prebuilt Node-API binaries inside its npm package, so `pnpm install` needs no compiler or Python and the binary doesn't depend on the exact Node version. `pnpm-workspace.yaml` ignores the package's install step, which would only run `node-gyp` and fail where it isn't installed.

| Platform | Binary | Tested here |
|---|---|---|
| Linux x64, glibc 2.34+ | yes | yes: install, query, on glibc 2.36 and 2.41; server tests on 2.41 |
| Linux x64, musl | yes | yes: install and query on Alpine |
| Linux arm64 (glibc 2.34+ or musl) | yes | no |
| macOS x64 and arm64 | yes | no |
| Windows x64 and arm64 | yes | no |

Other platforms have no binary, and glibc older than 2.34 can't load the one provided (it fails with ``version `GLIBC_2.33' not found``). `pnpm install` still succeeds there, and the server fails when it opens the database. To build from source, install Python, `make` and a C++20 compiler, then:

```sh
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
rm -rf prebuilds   # the loader prefers these over a local build
npx node-gyp rebuild --release
```

This worked on Debian 12 with g++ 12, taking over ten minutes, and failed on Ubuntu 20.04 with g++ 9.4, so on a system that old, upgrade instead. Reinstalling restores the prebuilds, so it has to be repeated afterwards. Building on macOS or Windows hasn't been tried.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server on :4096 with reload, plus Vite on :5173 proxying `/api` to it |
| `pnpm build && pnpm start` | Production: the server serves the built web UI on :4096 |
| `pnpm test` | Protocol, server API (mock model, no API key needed) and web component tests (Vitest + jsdom) |
| `pnpm test:e2e` | Chromium browser tests: built UI and real server with a scripted model; no API key. Install with `pnpm --filter @mivra/e2e exec playwright install chromium`. Runs on up to 4 workers (`MIVRA_E2E_WORKERS`), each with its own server and database. A run uses the ports from `MIVRA_E2E_PORT` (default 4198) to that plus the worker count minus one, so give concurrent runs separate blocks |
| `pnpm test:e2e:all` | Full browser suite, including graph tests in Firefox and WebKit. Required for graph, layout, font or keyboard changes. Install with `pnpm --filter @mivra/e2e exec playwright install chromium firefox webkit` |
| `pnpm typecheck` | Type-check all packages |
| `pnpm --filter @mivra/server db:generate` | Generate a migration after editing `src/db/schema.ts` |

Workspace packages resolve to their TypeScript source in dev, tests and type-checking through the `@mivra/source` export condition, so `pnpm dev` needs no prebuild. `pnpm build` compiles `packages/protocol` first; the production server loads its `dist`.

The pnpm patch for `@openrouter/ai-sdk-provider@3.1.0` handles a discarded stream-cancellation rejection that can exit Node after a client disconnect. Remove it when an upstream version handles that rejection and passes `packages/server/test/openrouter-exit.test.ts`.

Data is stored in `~/.mivra/mivra.db` (override with `MIVRA_DATA_DIR`). The API's OpenAPI document is at `/api/doc`.

## Learner memory

Each turn's instructions include part of the learner's record across all sessions: up to 30 recently practised concepts, each with how many checks were answered, how many were right, and the latest result. It is calculated from the latest 1000 graded attempts and never stored separately, so older practice stops counting (ADR-009).

The model can also save goals, preferences and misconceptions with the `remember` tool. They save automatically, take effect only if the reply completes, and appear in the sidebar's Memory panel, where the learner can edit or permanently delete them. A misconception is linked to a graded wrong answer on the same concept when there is one, and otherwise counts as only an impression from chat. A memory written while a check in its session is unanswered could give the answer away, so until the check is answered its content is hidden from the panel and left out of other turns, though it can still be deleted. One reply can save at most 5 memories, and the newest 40 are included in each turn. What was said in the chat itself stays in that session's conversation, so deleting a memory doesn't remove it from there.

## Uploaded documents

The learner can attach PDF and PPTX files of up to 25 MB to a session, up to 20 per session (ADR-010). The server extracts their text locally in a separate Node process and stores only that, split into chunks with their page or slide numbers and indexed with SQLite FTS5; the original file isn't kept. Deleting a document removes its text from storage and search, though replies already written from it stay in the conversation.

Each turn, the session's document names and page counts go to the model, along with up to 8,000 characters of excerpts: any page or slide the learner's latest message asks for by number ("page 3", "slides 2-4", and "page 3 of Week 2" for a named document), then what best matches the message, or the start of each document if nothing does. A page request with no document name reads that page from every document, and the tutor is told what was missing or cut. Only those excerpts reach the provider.

Document names and excerpts are escaped data in a separately labelled user-role message just before the learner's latest message. They are never stored or sent to the client, and they stay out of the system instructions, which hold only the trusted rule that this message is data and must never decide what the tutor does, remembers or reveals. That lowers a document's authority and makes hijacking the tutor harder, but it isn't immunity: the model reads the text and can still be persuaded by it.

Only text is read. Diagrams and images are lost, and scanned PDFs are refused because they have no text. Slide text comes from slide XML, including equations but not speaker notes. PDF maths depends on how the file was made: fonts with real Unicode extract cleanly, while LaTeX output keeps most symbols but flattens subscripts and superscripts (`fn` for f_n), loses the layout of fractions and sum limits, and can turn ≠ into `6 =`. A symbol such as ∈ isn't searchable, since search only indexes letters and digits.

Uploaded files are treated as hostile. The size cap applies to the whole request while reading, whatever it declares; a request with anything other than the one file is refused, and reading has a deadline (120 s) and stops if the client disconnects. The type is decided by content, zips have limits on entries and unpacked size, XML with a DTD is refused and entities are never expanded, and extraction runs in a subprocess that gets none of the server's environment, so a crash or running out of memory there only fails the upload. It stops at a timeout (120 s), a 512 MB heap limit or 2 GB of the subprocess's resident memory, with SIGTERM and then SIGKILL two seconds later; the upload's slot is freed only once the subprocess has exited. On Linux the server reads that memory from `/proc`; elsewhere the subprocess reports it itself, so a long blocking native call can overshoot 2 GB until it yields or the timeout fires.

## Web UI

The UI uses [shadcn/ui](https://ui.shadcn.com) with the Paper & Amber theme (ADR-008). Components are copied into `packages/web/src/components/ui`, and theme tokens live in `src/styles.css`. To add a component, run `pnpm dlx shadcn@latest add <name>` from `packages/web`, then check that it didn't overwrite the tokens in `styles.css`, and point any `from "cn"` import at `@/lib/utils`. Fonts are bundled through `@fontsource`, so the app needs no network for them. The theme follows the OS until the learner picks Light or Dark in the sidebar; the choice is saved in the browser.

## Access and security

- The server and the Vite dev server listen on `127.0.0.1` only.
- Every `/api` request except `/api/health` and `/api/doc` needs `Authorization: Bearer <token>`. The token is created on first start in `~/.mivra/auth-token` (mode 0600). The web UI gets it from a meta tag in `index.html`, injected by the server (production) or Vite (dev).
- The server rejects any `Host` that isn't loopback or listed in `MIVRA_ALLOWED_HOSTS`. This stops DNS-rebinding pages from reading the token.
- To use the UI from another device on your tailnet, proxy it instead of binding all interfaces: `tailscale serve --bg 5173` in dev, or `tailscale serve --bg 4096` plus `MIVRA_ALLOWED_HOSTS=<machine>.ts.net` in production.

For scripts: `curl -H "Authorization: Bearer $(cat ~/.mivra/auth-token)" http://127.0.0.1:4096/api/sessions`.

## Chat turns

Each reply is a *run* (`runs` table). A session has at most one running run, so a second send while a reply streams gets `409`. Message ids are single-use, so a retried request is rejected rather than generating twice. Completed replies are saved in full. Stop cancels the model call and records the run as `cancelled`; cancelled text remains visible after reload, artifact/tool parts are discarded and pending memories roll back. Stop targets the learner message id (`POST /api/sessions/{id}/stop` with `{ "messageId": "..." }`), so a stale request cannot cancel a later reply. Cancelled replies are excluded from later model context; provider errors are recorded as `failed` with the error. Runs left running when the server stops are marked `failed` on the next start.

Automatic quiz continuations run on the server even with no tab connected. `GET /api/sessions/{id}/continuation` replays the current run's redacted SSE chunks and then streams live chunks; disconnecting only detaches the subscriber. Its `x-mivra-continuation-stop-id` header supplies the unique run token to send as Stop’s `messageId`, so delayed cancellation cannot affect a later continuation. With no continuation running it returns `204` immediately, with a safe `x-mivra-continuation-error` header if the last continuation failed. The web client checks after an answer, session load, focus or visibility restoration, uses the normal chat state for streaming, and reconciles stored messages once at completion. It has no idle polling or periodic fallback.

## Learning artifacts

The agent shows interactive artifacts through tool calls (ADR-006): `show_algorithm_trace`, `show_set_diagram`, `show_graph`, `ask_multiple_choice`, `show_table` and `show_worked_steps`, registered by the first-party `core-learning` plugin (`packages/server/src/plugins/`) through the capability registry (ADR-007).

- Each tool call's input is validated against its `packages/protocol` schema and stored in `artifacts` with the full spec. Client output fails closed: the live stream and `GET /api/sessions/{id}/messages` pass only text, reasoning text and lifecycle parts plus `data-artifact` parts with the artifact's public view. Raw tool calls, provider metadata, sources and files never reach a client. Thinking streams into a collapsed disclosure: opening it may reveal answers mentioned by the model (ADR-006). Private artifact fields still stay on the server.
- `POST /api/artifacts/{id}/attempts` with `{ "answer": { "optionIndex": n } }` grades a check deterministically and returns the view with the grade. One attempt per check, accepted once the reply that asked it has finished.
- On later turns, each check's tool result tells the model whether the learner answered and how they did.
- The web UI renders `data-artifact` parts by kind (`packages/web/src/artifacts/`). Each part is validated against the protocol's `ArtifactView` first; anything that fails shows a "can't display this item" placeholder. Every stepped kind shares one stepper (prev/next, play/pause, arrow keys, and no controls for a single step), and at either end prev or next stays focusable, so the keyboard keeps its place. One polite live region in each announces the current step whole, whichever way the learner moved: its number, explanation, and what's otherwise only drawn, so steps with the same explanation aren't silent, and the visible counter is hidden from screen readers so it isn't said twice. A trace is that stepper over a sequence, and also announces which values the step changed. A set diagram is a Venn diagram of 1 to 3 sets, stepped if it has steps; each region is computed as its exact shape, so a step can highlight any region, and what a region holds is measured against its exact space at the drawn size, re-measured on resize; what doesn't fit moves to a list below the diagram, leaving a marker such as `n = 30 ↓` or just `↓`. A count shows as `n = 7`, so it can't be mistaken for an element. A graph is drawn by the browser, never placed by the model: d3-hierarchy for a real tree when `kind` is `tree`, where an edge's optional `side` keeps a lone child to its left or right, and otherwise a d3-force layout run to the end once per graph, so it's deterministic and nothing moves while stepping. It's stepped if it has steps. Self-loops and parallel edges are drawn. Labels are HTML over the SVG and scale with it down to 11px, after which the graph scrolls in its own box, which then takes the arrow keys for scrolling and is a named tab stop. The layout estimates a label's size from its source and never measures it, so positions can't shift once fonts load; each label is clipped to that estimated box, so none can overlap another for being wider than estimated. Rendered labels are measured only to tell which were cut short: those are marked `…` and listed in full below the drawing, for sighted readers, as the screen-reader description already has them. A check posts the learner's choice and then shows the grade. After all checks in the latest reply are answered, the tutor continues automatically once, without a new learner message; sending a message first takes the place of that continuation. Its options stay disabled while the reply that contains it is still streaming, and once it has been answered. A table is a real `<table>` for truth tables and relation matrices: static, or stepped if it has steps, where changed cells persist and highlights last one step. Worked steps reveal a proof cumulatively, with a "Show all" control; only the current step is announced, and the earlier ones stay in the list to read. Only a check has anything to keep private.

## Markdown and maths

`MathText` (`packages/web/src/MathText.tsx`) renders model-written text in one of two modes:

- `block`, for replies: GitHub-flavoured markdown with KaTeX maths, `$...$` inline and `$$...$$` display.
- `math`, for artifact text: a trace's title and step explanations, every label, element and variable in a set diagram, a graph's title, step explanations, node labels and edge labels, a check's question, option text, feedback and explanation, a table's title, headers, cells and explanations, and all worked-steps text. Only `$...$` is a formula and `\$` a dollar. Everything else is literal, including `$$`, so the options `2*3*4` and `234` stay different. For a large formula, start it with `\displaystyle`. A new artifact field that may hold an answer or a structured value should use this mode; explanatory prose may use `block`.

Concept labels, a trace's cell values, pointer names, range labels and variables, and a graph's variables and edge weights aren't passed through `MathText`, and learner messages stay plain.

A `$...$` is maths only if there's no whitespace just inside its dollars, no digit just after the closing one, and no backtick between them, and the first dollar after the opening one decides. So "costs $5 and $10" isn't a formula. In `block` mode, code and `\$` take precedence over a dollar. Raw HTML shows as text, images show their alt text and never load, and only `http`, `https` and `mailto` links work. A reply is rendered block by block, so a streamed delta only re-renders its last block; a block over 50,000 characters, or with absurdly deep nesting at its line starts or a run of more than 32 `[` outside code, shows as plain text with its code still in a box, and so does a block that fails to render. Other hostile nesting, such as `[a [a [a ` repeated thousands of times, isn't detected and renders slowly.
