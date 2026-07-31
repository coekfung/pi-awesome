# pi-awesome

A compact collection of practical extensions for [Pi](https://github.com/mariozechner/pi-coding-agent), focused on performance visibility, safer shell execution, notebook editing, and MCP integration.

## What’s included

- `perf/perf.ts` — shows TTFT and approximate output throughput in the UI status line; adds `/perf` for per-turn session metrics with provider/model info
- `nono/nono.ts` — detects whether the Pi process is running inside a [nono](https://github.com/always-further/nono) sandbox via environment variables
- `notebook-edit/notebook-edit.ts` — provides a `notebook_edit` tool for Jupyter cell edits with pi-style guidance and serialized file writes
- `mcp/mcp.ts` — provides MCP tool listing/calling and adds configured MCP servers (with optional per-server `prompt` use-case hints from `mcp.json`) to the system prompt; invalid `mcp.json` files are reported as startup warnings
- `usage/usage.ts` — shows the active model's provider usage/quota in the status line; adapters resolve auth, fetch, and normalize per-provider data; currently supports OpenAI Codex (e.g. `📊 codex: 59% 5h 61% wk`) and DeepSeek (e.g. `📊 deepseek: ¥59.00 rem`); query failures surface as a once-per-session warning

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
