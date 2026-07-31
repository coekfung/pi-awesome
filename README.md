# pi-awesome

A compact collection of practical extensions for [Pi](https://github.com/mariozechner/pi-coding-agent), focused on performance visibility, sandbox detection, notebook editing, MCP integration, and provider usage visibility.

## What’s included

- `perf/perf.ts` — shows TTFT and approximate output throughput in the UI status line; adds `/perf` for per-turn session metrics with provider/model info
- `nono/nono.ts` — reports nono installation and environment-based sandbox status
- `notebook-edit/notebook-edit.ts` — provides a `notebook_edit` tool for editing Jupyter notebook cells (replace, insert, delete)
- `mcp/mcp.ts` — provides MCP tool listing/calling and adds configured MCP servers (with optional per-server `prompt` use-case hints from `mcp.json`) to the system prompt
- `usage/usage.ts` — shows the active model's provider usage/quota in the status line; supports OpenAI Codex (e.g. `📊 codex: 59% 5h 61% wk`) and DeepSeek (e.g. `📊 deepseek: ¥59.00 rem`)

## Installation

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
```

- Source code lives in per-extension subdirectories: `perf/`, `nono/`, `notebook-edit/`, `mcp/`, `usage/`
- The project uses TypeScript with ESM modules
- `npm run check` runs TypeScript and formatting checks
- `npm run check:fix` applies Prettier fixes, then reruns checks
