# AI Commit for Obsidian

Generate meaningful git commit messages via [DeepSeek AI](https://deepseek.com) directly from [Obsidian Git](https://github.com/Vinzent03/obsidian-git) source control view.

Adds a sparkle button next to the Commit button. Click it to generate a commit message from staged changes.

## Features

- **One-click generation** — button in Obsidian Git source control view, or via command palette
- **DeepSeek V4 Flash** — fast and cheap default model, V4 Pro available
- **Customizable prompt** — adjust language, style, and tone
- **Timeout & retry** — configurable timeout (10–120s) with automatic retries (3 attempts)
- **Plain messages** — no Conventional Commits prefixes (unless you configure them in custom instructions)

## Requirements

- [Obsidian Git](https://github.com/Vinzent03/obsidian-git) plugin installed and configured
- [DeepSeek API key](https://platform.deepseek.com/api_keys)
- Git available on the system

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
| API Key | — | DeepSeek API key (stored locally, never sent anywhere but DeepSeek) |
| Model | DeepSeek V4 Flash | V4 Flash (fast/cheap) or V4 Pro (more capable) |
| Timeout | 30s | API request timeout (10–120s) |
| Custom instructions | — | Extra prompt rules (e.g. "Always write in Russian") |

## How It Works

1. Stage files in Obsidian Git
2. Click the ✨ button (or `Ctrl+P` → "Generate commit message")
3. The plugin runs `git diff --cached`, sends the diff to DeepSeek
4. The generated message appears in the commit text area
5. Review and click Commit

## Development

```bash
npm install
npm run dev     # Watch mode
npm run build   # Production build
```
