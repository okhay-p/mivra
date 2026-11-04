---
status: accepted
date: 5 November 2026
---

# ADR-013: Distribution through npm and Docker, with API keys set in the UI or CLI

**Context:** Mivra only runs from a clone today: `pnpm install`, `cp .env.example .env`, then `pnpm build && pnpm start`. ADR-001 asks for a default install that "feels like a standalone app that launches its own server automatically", and ADR-003 puts Electron later. Every workspace package is `private`. The server reads `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from `process.env` once at startup (`packages/server/src/main.ts`), so an installed copy has no way to receive a key except environment variables. The one native dependency is `better-sqlite3`, which ships prebuilt binaries for macOS (arm64, x64), Linux glibc (x64, arm64) and Windows x64; anywhere else it compiles from source.

**Options:**

- Distribution: (A) npm only; (B) Docker only; (C) both, built from the same artifact; (D) a single executable (Node SEA or similar).
- API keys: (1) environment variables only; (2) entered in the UI; (3) set with a CLI command; (4) both (2) and (3) over one store, with env vars still honoured.

**Decision:** (C) and (4).

### Distribution

- **npm is the main install.** One public package, `mivra`, built from `pnpm build`: the server, the built web assets, and `@mivra/protocol` bundled in, since that package stays private. `npx mivra` (or a global install) starts the server and opens the browser, which suits learners who never configure a server. It runs in the foreground and stops with Ctrl+C; `mivra --detach` starts it in the background (pid and log files in the data dir) and `mivra stop` ends it. If port 4096 is taken, it tries the following ports and prints the URL it got. When `MIVRA_PORT` is set explicitly, a taken port is an error instead, so scripts and e2e get the port they asked for. It needs Node ≥ 22.14; the `mivra` binary checks the version first and prints a clear message instead of a stack trace. A failed `better-sqlite3` load points the user to the Docker image.
- **Docker is the second install,** for home servers, NAS and VPS hosts (the remote-access case in ADR-001), platforms without a `better-sqlite3` prebuild, and users who don't want Node. The image installs the same npm build on `node:22-slim` and is published to GitHub Container Registry as `ghcr.io/okhay-p/mivra`: no separate account, no anonymous pull limits, and it's linked from the repo. A Docker Hub mirror can follow if users ask for it. Data lives in a `/data` volume (`MIVRA_DATA_DIR=/data`). The documented `docker run` publishes the port on `127.0.0.1` only. Keys come in as env vars, or through the CLI with `docker exec`.
- **Electron (ADR-003) is still the long-term app** and will wrap the same server build.
- **Releases start manual.** A release checklist in `README.md` covers the version bump, the build, `pnpm publish` and pushing the image. Once that checklist has been through a release or two, a GitHub Actions release workflow takes it over: on a version tag it builds, publishes to npm and pushes the image. That workflow only builds and publishes. Tests still run in the review gate, not in CI.

### API keys

- **One store.** Keys saved through the UI or the CLI go in `credentials.json` in the data dir, written with mode `0600` like `auth-token`. They stay **out of `mivra.db`**, so copying or backing up the database never carries a key. An OS keychain (Electron's `safeStorage` included) can replace the file later behind the same interface.
- **Lookup order: env var, then the store.** Docker, the dev `.env` and e2e keep working unchanged. Keys are looked up when each run starts (not once at boot), and the provider catalog refreshes when a key changes, so a new key takes effect without a restart.
- **UI: Settings → Model providers.** It lists OpenRouter, Anthropic and OpenAI, each shown as "not set", "set (…last four)" or "from environment" (env keys can't be edited or removed there). Keys are write-only: the server never returns one, only that view, as with every other client view. A **Test** button makes one cheap authenticated call. With no key anywhere, the app opens this page as first-run onboarding instead of failing on the first message.
- **Only local requests change keys.** `PUT`/`DELETE` on keys accept a request only when its peer address is loopback. The Host header can't be trusted for this, since `hostGuard` only checks what the client claims. Clients on `MIVRA_ALLOWED_HOSTS` (a tailnet, for instance) see the status read-only, with a note to use the CLI on the host. Inside Docker, browser requests come from the bridge network, so Docker users set keys through env vars or `docker exec … mivra auth set`.
- **Base URLs stay env-only.** Anyone who can change `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` can send the key to their own server, so the UI never edits them.
- **CLI: `mivra auth`.** `mivra auth set <provider>` reads the key from a hidden prompt (or from stdin when it isn't a TTY), never from an argument, so it doesn't end up in shell history or `ps`. `mivra auth status` prints the same view as the UI, and `mivra auth remove <provider>` deletes a stored key. The CLI writes the file directly, and a running server picks the change up on the next run.

**Consequences:** Mivra becomes installable without a clone, and setting a key is something a learner does in the app rather than in a config file. Upgrades now reach strangers' databases, so migrations must run safely on startup. That makes the open "SQLite operations" question (backups, schema versioning) more urgent: a pre-migration backup of `mivra.db` is the minimum before the first release. Keys sit in plain text on disk, protected by file permissions only, as with `gh` and `npm`. We keep a Dockerfile and, until the release workflow lands, a manual release process. Platforms with neither a Node prebuild nor Docker aren't supported.

**Still open within this decision:** update notices; multi-arch images (amd64 and arm64).

**Build order:**

1. Credential store, the env-then-store lookup, and per-run key resolution with catalog refresh (server only, with tests).
2. Settings → Model providers page, first-run onboarding and the loopback-only write rule.
3. Publishable `mivra` package with the `mivra` binary (foreground start with port fallback, `--detach` and `stop`, browser open, Node version check) and `mivra auth`.
4. Pre-migration backup, then the first npm release.
5. Dockerfile and image on GHCR, plus the release checklist in `README.md`.
6. GitHub Actions release workflow on version tags, once the checklist has been used for a real release.
