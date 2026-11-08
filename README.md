# Mivra

A local-first AI tutor that teaches with interactive visualizations, checks and courses. Mivra runs on your own computer: there's no account to create, and your learning history stays in a local database. You bring an API key for the model you want to learn with.

## What it does

- **Teaches with things you can step through.** Alongside its explanations, the tutor shows algorithm traces, Venn diagrams, graphs and trees, truth tables and step-by-step worked proofs. Each one has play, pause and step controls, and works with the keyboard and screen readers.
- **Checks your understanding.** Multiple-choice checks are graded exactly by Mivra, not guessed by the model. Once you've answered, the tutor continues from how you did.
- **Builds courses.** Give it a goal. After a short placement interview, it writes a syllabus and generates each lesson when you reach it. The next lesson starts by revisiting what you got wrong. You can ask it to explain any section or change the plan.
- **Remembers you.** It keeps track of the concepts you've practised and how you did, plus goals and preferences it notes along the way. You can see, edit and delete those notes in the Memory panel.
- **Reads your course material.** Attach PDF or PowerPoint files (up to 25 MB each) and ask about them, down to "explain slide 4".
- **Uses the model you choose.** Pick any tool-capable model from OpenRouter, Anthropic or OpenAI, and how hard it should think, from the picker under the message box.

## Get started

You need [Node.js](https://nodejs.org) 22.14 or newer.

```sh
npx @okhay-p/mivra
```

Or install it once with `npm install -g @okhay-p/mivra` and then run `mivra`.

Mivra starts and opens in your browser at <http://127.0.0.1:4096>. The first time, it asks for an API key. An [OpenRouter key](https://openrouter.ai/keys) reaches every model; an Anthropic or OpenAI key calls that provider directly. You can add or change keys any time under **Model providers** in the sidebar, and **Check** tests a key without spending anything.

## Commands

| Command | What it does |
|---|---|
| `mivra` | Start Mivra and open it in your browser. Ctrl+C stops it |
| `mivra start --detach` | Run it in the background |
| `mivra stop` / `mivra status` | Stop the background Mivra, or show where it's running |
| `mivra auth set <provider>` | Save an API key for `openrouter`, `anthropic` or `openai`. It asks for the key without showing it |
| `mivra auth status` / `mivra auth remove <provider>` | See where each key comes from, or remove a saved one |
| `mivra import obsidian <folder>` | Import an Obsidian vault's notes into a running Mivra. Run it again after you've changed the vault to update it. `--name` names the import |

Mivra uses port 4096, or the next free one if that's taken. `--port <n>` asks for a specific port, and `--no-open` skips opening the browser.

## Docker

```sh
docker run -d --name mivra --restart unless-stopped \
  -p 127.0.0.1:4096:4096 -v mivra-data:/data \
  -e OPENROUTER_API_KEY=sk-or-... \
  ghcr.io/okhay-p/mivra
```

Then open <http://127.0.0.1:4096>. Your data is kept in the `mivra-data` volume. Because the browser reaches the container over Docker's network, keys can't be changed from the app here: pass them with `-e`, or save one with `docker exec -i mivra mivra auth set openrouter`.

Docker is also the easiest route on systems Mivra has no prebuilt database driver for (see [Supported systems](#supported-systems)).

## Your data and privacy

- Everything is stored in `~/.mivra` (set `MIVRA_DATA_DIR` to move it). Before an update changes the database, Mivra saves a backup in `~/.mivra/backups` and keeps the latest five.
- API keys are saved in `~/.mivra/credentials.json`, readable only by you, and are never sent back to the browser. Keys in `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` take precedence over saved ones.
- What reaches the model provider: your conversation, a short summary of your recent progress and saved notes, and excerpts of any documents you've attached that are relevant to your question. Uploaded files themselves aren't kept: Mivra extracts their text on your computer and stores only that.
- An imported Obsidian vault is copied into Mivra's database: only its Markdown notes, never attachments or the `.obsidian` folder. Mivra never writes to the vault.
- Mivra listens on `127.0.0.1` only, and every request needs a private access token, so other devices and websites can't reach it.

### Using it from another device

To use Mivra from your phone or another computer, put a proxy in front of it rather than opening it to the network. With [Tailscale](https://tailscale.com), for example:

```sh
tailscale serve --bg 4096
MIVRA_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net mivra
```

API keys can only be changed from a browser on the computer running Mivra.

## Good to know

- Only the text of uploaded documents is read. Images and diagrams are lost, and scanned PDFs with no text layer can't be used. Maths in PDFs made with LaTeX may come through imperfectly.
- Uploaded documents are treated as untrusted, and their text is clearly marked as data for the tutor. That makes it harder for a document to steer the tutor, but no model is fully immune to instructions hidden in text it reads.
- The tutor's thinking can be opened under each reply. It may mention the answer to a check, so leave it closed until you've answered.

## Supported systems

The npm package works on Linux (x64 and arm64, glibc 2.34+ or musl), macOS and Windows. On older Linux systems, such as Ubuntu 20.04, use the Docker image.

## Contributing

Mivra is open source. To run it from source, run the tests or find your way around the code, see [`docs/development.md`](docs/development.md). Design decisions are recorded in [`docs/adr/`](docs/adr/README.md). Bug reports and ideas are welcome in [GitHub Issues](https://github.com/okhay-p/mivra/issues).

## License

MIT, see [`LICENSE`](LICENSE). The published package lists the licenses of the code it bundles in `THIRD_PARTY_NOTICES.md`.
