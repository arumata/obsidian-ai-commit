# AI Commit for Obsidian

Generate meaningful git commit messages via [DeepSeek AI](https://deepseek.com) or a local [Ollama](https://ollama.com) model directly from [Obsidian Git](https://github.com/Vinzent03/obsidian-git) source control view.

Adds a sparkle button next to the Commit button. Click it to generate a commit message from staged changes.

## Features

- **One-click generation** — button in Obsidian Git source control view, or via command palette
- **Two providers** — DeepSeek (cloud, V4 Flash/Pro) or Ollama (local, any pulled model), switchable in settings
- **Model detection** — auto-detect models installed in your local Ollama instance
- **Customizable prompt** — adjust language, style, and tone
- **Timeout & retry** — configurable timeout (10–120s) with automatic retries (3 attempts)
- **Plain messages** — no Conventional Commits prefixes (unless you configure them in custom instructions)

## Requirements

- [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin installed and configured
- Git available on the system
- Either:
  - a [DeepSeek API key](https://platform.deepseek.com/api_keys), or
  - a local [Ollama](https://ollama.com) install with at least one model pulled (`ollama pull llama3.1`)

## Installation

### From Community Plugins

1. Open Settings → Community Plugins
2. Search "AI Commit"
3. Install and enable

### Manual (BRAT)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add `arumata/obsidian-ai-commit` as a beta plugin

### Manual (direct)

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/arumata/obsidian-ai-commit.git ai-commit
cd ai-commit && npm install && npm run build
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Provider | DeepSeek | DeepSeek (cloud) or Ollama (local) |
| API Key | — | *(DeepSeek)* API key (stored locally, never sent anywhere but DeepSeek) |
| Model | DeepSeek V4 Flash | *(DeepSeek)* V4 Flash (fast/cheap) or V4 Pro (more capable) |
| Ollama server URL | `http://localhost:11434` | *(Ollama)* Base URL of your local Ollama server |
| Ollama model | `llama3.1` | *(Ollama)* Name of a pulled model; use the refresh button to detect installed models |
| Timeout | 30s | API request timeout (10–120s) |
| Custom instructions | — | Extra prompt rules (e.g. "Always write in Russian") |

## How It Works

1. Stage files in Obsidian Git
2. Click the ✨ button (or `Ctrl+P` → "Generate commit message")
3. The plugin runs `git diff --cached`, sends the diff to DeepSeek or your local Ollama server
4. The generated message appears in the commit text area
5. Review and click Commit

### Using Ollama

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3.1`
2. Make sure the Ollama server is running (`ollama serve`, or it's already running if you installed the desktop app)
3. In AI Commit settings, set Provider to "Ollama (local)"
4. Click the refresh icon next to "Ollama model" to auto-detect installed models, or type a model name manually
5. Everything else works the same as with DeepSeek — nothing leaves your machine

## Development

```bash
npm install
npm run dev     # Watch mode
npm run build   # Production build
```
