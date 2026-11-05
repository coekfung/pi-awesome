# pi-awesome

A compact collection of practical extensions for [Pi](https://github.com/earendil-works/pi), focused on performance visibility, sandbox detection, notebook editing, and provider quota visibility.

## What’s included

- `perf/perf.ts` — shows TTFT and approximate output throughput in the UI status line; adds `/perf` for per-turn session metrics with provider/model info, adapting to terminal size and theme changes
- `nono/nono.ts` — reports nono installation and environment-based sandbox status
- `notebook-edit/notebook-edit.ts` — disabled by default; provides a `notebook_edit` tool for editing Jupyter notebook cells (replace, insert, delete)
- `quota/quota.ts` — shows the active model's provider quota in the status line; supports OpenAI Codex (e.g. `📊 codex: 59% 5h 61% wk`) and DeepSeek (e.g. `📊 deepseek: ¥59.00 rem`)
- `openai-fast/openai-fast.ts` — toggles OpenAI/Codex fast mode with `/fast` and displays its status (e.g. `⚡️ fast: on`)

MCP integration uses Pi's built-in support; this package no longer provides an MCP extension.

## Installation

Requires Pi 1.0.4 or later in the 1.x series.

Install directly from GitHub:

```bash
pi install git:github.com/coekfung/pi-awesome
```

Pi loads the extensions declared in `package.json > pi.extensions` automatically after installation.

## Development

```bash
npm install
npm run check
npm run check:fix
npm run test
```

- Source code lives in per-extension subdirectories: `perf/`, `nono/`, `notebook-edit/`, `quota/`, `openai-fast/`
- The project uses TypeScript with ESM modules
- `npm run check` runs TypeScript and formatting checks
- `npm run check:fix` applies Prettier fixes, then reruns checks
- `npm run test` runs unit tests with Node's built-in test runner
