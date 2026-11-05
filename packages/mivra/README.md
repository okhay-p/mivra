# Mivra

A local-first AI tutor that teaches with interactive visualizations, checks and courses. Everything runs on your computer: no account, and your data stays in `~/.mivra`.

## Start

Needs [Node.js](https://nodejs.org) 22.14 or newer.

```sh
npx @okhay-p/mivra
```

Or install it once with `npm install -g @okhay-p/mivra`, then run `mivra`.

This starts Mivra and opens it in your browser. The first time, it asks for an API key from [OpenRouter](https://openrouter.ai/keys) (one key reaches every model), Anthropic or OpenAI.

## Commands

| Command | What it does |
|---|---|
| `mivra` | Start Mivra and open it; Ctrl+C stops it. Uses port 4096, or the next free one |
| `mivra --detach` | Run it in the background |
| `mivra stop` / `mivra status` | Stop the background Mivra, or say where it runs |
| `mivra auth set openrouter` | Save an API key (also `anthropic`, `openai`); it asks for the key without showing it |
| `mivra auth status` / `mivra auth remove <provider>` | See or remove saved keys |

Options: `--port <n>` to use one port only, `--no-open` to skip the browser. `MIVRA_DATA_DIR` moves the data folder. Keys in `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` take precedence over saved ones.

Only a browser on the same computer can change API keys. Mivra listens on `127.0.0.1` only.

Source, issues and design decisions: <https://github.com/okhay-p/mivra>
