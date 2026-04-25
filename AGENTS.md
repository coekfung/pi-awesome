# AGENTS.md

## Overview

`pi-awesome` is a small TypeScript repository of Pi extensions. Active extension entrypoints are listed in `package.json > pi.extensions`.

## Response style

- Keep answers short, direct, and technical.
- State what changed and what you validated when relevant.
- No filler text.

## Important files

- `extensions/perf.ts` — UI performance footer
- `extensions/nono.ts` — nono sandbox detection
- `extensions/notebook-edit.ts` — Jupyter notebook cell editing tool
- `extensions/mcp.ts` — MCP client with tool listing, calling, and status UI

## Code rules

- Keep edits minimal and localized. This includes comments and abstraction layers.
- Preserve each touched file’s existing formatting style.
- Maintain strict TypeScript compatibility and avoid unnecessary dependencies.
- Avoid `any` unless there is no reasonable typed alternative.
- Prefer standard top-level imports over dynamic imports.
- Do not rename public tool names or change tool parameters without clear justification.
- Ask before removing functionality or behavior that appears intentional.
- If user-facing behavior changes, update `README.md` in the same task.
- Don't write a helper that doesn't make its callers simpler than the code it wraps.

## Validation

- For code changes, run `npm run check`.
- `npm run check` runs `tsc -p tsconfig.json --noEmit` and `prettier --check .`.
- `npm run check:fix` applies `prettier --write .`, then reruns checks.
- Docs-only changes usually do not require full validation.
- There are no `build` or `clean` npm scripts.

## Git safety

- Review recent git history before writing a commit message so you can follow the repository's existing commit message convention.
- Never commit unless the user asks.
- Stage only files changed in the current task.
- Do not use broad staging or destructive commands such as `git add .`, `git add -A`, `git reset --hard`, `git checkout .`, `git stash`, or `git clean -fd`.
- If unrelated changes are present, leave them untouched.
