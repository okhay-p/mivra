---
status: proposed
date: 13 November 2026
---

# ADR-016: Code exercises in the browser, and project courses checked in the learner's own repo

**Context:** Issue #96 asks for editable code and coding exercises with tests and feedback. Mivra has non-executing walkthroughs (#74) but runs no code. A first draft (12 November 2026) chose a self-hosted Piston service for general languages and Sandpack for React. Review found that Piston's documented install is a `--privileged` Docker container (close to root on a native Linux host) with an unauthenticated package-install endpoint, published on every interface by default; that JavaScript and Python don't need it; that Sandpack fetches npm packages from public registries at run time and needs a second origin for isolation; and that most learners who start Mivra with `npx` would never set up Docker. The owner chose a narrower design on 13 November 2026.

**Options:**

- (A) Piston for general languages, Sandpack for React (the first draft).
- (B) Browser-only runtimes for every language.
- (C) Browser runtimes for JavaScript and Python inside lessons; every other language, and anything bigger than one file, as a **project course** in the learner's own repository, checked by a `mivra check` command that runs there.
- (D) As (C), plus an MCP server so a coding agent in the learner's editor can drive checks.

**Decision:** (C).

### In-lesson exercises (browser)

- **A new artifact kind** for a single-file exercise (name decided in implementation), with its schema in `packages/protocol` (rejecting `{}`) and registered through a server plugin (ADR-007). It holds instructions, the language, starter code, test cases and a reference solution. `toView` keeps the reference solution out of the client view.
- **JavaScript runs in QuickJS** (compiled to WebAssembly) in a Web Worker. QuickJS enforces a time limit (interrupt handler) and a memory limit, and exposes no DOM or network: only what Mivra passes in, such as captured `console` output.
- **Python runs in Pyodide** in a Web Worker. Stopping the worker is the hard time limit; memory can't be capped, but the worst case is a killed worker. Pyodide can reach the browser's `fetch` through its `js` module, so the implementation must remove network access from the worker before running learner code, and verify it.
- **Workers never receive the API token** or any learner data beyond the exercise itself. Output is capped, and the learner can stop a run.
- **Tests:** stdin/stdout cases and, for these two languages, function-call cases with JSON arguments. **Run** executes the visible cases and records nothing. **Submit** runs every case in the browser and posts the results as an attempt to `POST /api/artifacts/:id/attempts` (ADR-006). Hidden cases are hidden in the UI only, since the browser runs them.
- **The tutor's tests are checked before the learner sees them.** When the exercise is created, the server runs the reference solution against the cases (QuickJS or Pyodide in a Node worker, no host filesystem mounted, with a time limit), and the expected outputs come from that run, not from text the model typed. An exercise whose reference fails or times out is rejected and the model retries.
- **Assets** (QuickJS and Pyodide) are served by Mivra, so exercises work offline once they're present. Whether they ship in the npm package or download on first use is decided in implementation, by package size.

### Project courses (the learner's repo)

- **A project course** is a course (ADR-011) whose units are milestones. Each milestone has a spec, an exact output format and a check type: `tests` or `review`.
- **`tests` milestones** use test inputs written by the tutor. Expected outputs come from running a **Python reference** written by the tutor in Pyodide on the server, whatever language the learner uses: the reference only has to compute what the learner's program should print. When output text can legitimately differ (generated assembly, for instance), the case runs the learner's output and compares what that prints. A milestone the reference can't express (Pyodide has no threads or subprocesses) is written as `review` instead.
- **`review` milestones** cover what output can't show: structure, a language feature, concurrency, performance. A model reviews the code.
- **`mivra link <course>`** in the repo writes `.mivra.json` with the course id and a run command the learner chooses (for example `./build/mycc {input}`). It holds no secrets and is safe to commit.
- **`mivra check`** fetches the current milestone's cases from the server **as data**, runs the learner's command on each case locally with a time limit and an output cap, compares results after a defined normalisation (such as trailing whitespace), and sends the results and the changes since the last passed milestone back to the server. **Mivra never sends a command to run.** The only command that runs is the one the learner set, so neither model output nor text in the repo can run anything on the host.
- **Passing needs both:** every test passes (for a `tests` milestone) and the model review approves. The review cannot turn a failed test into a pass, and it catches what tests can't, such as hard-coded outputs. Test results and the review verdict are recorded as separate evidence (ADR-009); the review is marked as model-judged.
- **Disputes.** The learner can dispute a test case or a review verdict. The tutor looks again and may correct or withdraw the case; the dispute and its outcome are recorded.
- **What leaves the repo.** `mivra check` follows `.gitignore`, skips secret-looking files (`.env*`, private keys, credential files), caps the size it sends, and can list what it would send (`--dry-run`). The tutor treats file contents as data, never as instructions.
- **Finding the server.** The CLI reads the server address and token from the local data dir, as `mivra auth` does. For a server on another machine, `mivra link --server <url>` stores the URL and token in the laptop's data dir (the credential store from ADR-013), never in `.mivra.json`. The learner copies the token from a "Connect a CLI" item in Settings or from a `mivra` command on the server. For Docker on a home server, the documented setup keeps the container on loopback, exposes it with `tailscale serve`, and adds the host to `MIVRA_ALLOWED_HOSTS`. The checks still run on the learner's machine, next to the code and its toolchain.

### Not doing

- **React previews** are dropped. React is learned as a project course.
- **Piston and Sandpack** are not adopted, for the reasons in Context. (B) is rejected because native compilers and multi-file projects don't fit the browser. (D) is dropped for now: an agent in the same repo can simply write the solution, and the CLI covers the learner's own path.

**Consequences:**

- No Docker or extra service. A learner can use any language they have installed, at any project size.
- Mivra does not sandbox project-course code. It runs as the learner's own tool, with the same trust as their own `make test`, started by them.
- Grading still starts deterministic, but two things extend ADR-006 and need the owner's approval with this ADR: browser exercises are graded from results the browser reports (not tamper-proof, accepted for a single-user local app), and project milestones add a model-graded code review alongside the tests.
- The same model writes the tests and the reference, so the reference catches mistakes in the expected outputs but not a misread spec. Disputes and the review are the safety net.
- Output-only tests can be gamed; the review mitigates this, it doesn't eliminate it.
- QuickJS and Pyodide add several megabytes of assets.

**Still open within this decision:** artifact and milestone schemas; exact limits; asset packaging; TypeScript (via a transpiler) for browser exercises; output normalisation rules; the review rubric; how milestones fit ADR-011's syllabus and freezing; the remote-server token flow; run-command quoting on Windows.

**Build order:**

1. Exercise artifact kind and JavaScript in QuickJS, with reference checking at creation.
2. Python in Pyodide.
3. Project courses: milestones, `mivra link` and `mivra check` with `tests` milestones against a local server.
4. Model review, `review` milestones and disputes.
5. CLI against a remote server (token flow, Tailscale docs).
