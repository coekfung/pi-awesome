# AGENTS.md

## Overview

`pi-awesome` is a small TypeScript repository of Pi extensions. Active extension entrypoints are listed in `package.json > pi.extensions`.

## Response style

- Keep answers short, direct, and technical.
- State what changed and what you validated when relevant.
- No filler text.

## Important files

- `extensions/ttft.ts` — UI performance footer
- `extensions/sandbox.ts` — sandboxed `bash` override
- `extensions/notebook-edit.ts` — Jupyter notebook cell editing tool
- `extensions/kimi/common.ts` — shared Kimi helpers
- `extensions/kimi/search.ts` / `extensions/kimi/fetch.ts` — Kimi web tools

## Code rules

- Keep edits minimal and localized.
- Preserve each touched file’s existing formatting style.
- Maintain strict TypeScript compatibility and avoid unnecessary dependencies.
- Avoid `any` unless there is no reasonable typed alternative.
- Prefer standard top-level imports over dynamic imports.
- Do not rename public tool names or change tool parameters without clear justification.
- Ask before removing functionality or behavior that appears intentional.
- If user-facing behavior changes, update `README.md` in the same task.

## Validation

- For code changes, run `npm run check`.
- `npm run check` runs `tsc -p tsconfig.json --noEmit` and `prettier --check .`.
- `npm run check:fix` applies `prettier --write .`, then reruns checks.
- Docs-only changes usually do not require full validation.
- There are no `build` or `clean` npm scripts.

## Git safety

- Never commit unless the user asks.
- Stage only files changed in the current task.
- Do not use broad staging or destructive commands such as `git add .`, `git add -A`, `git reset --hard`, `git checkout .`, `git stash`, or `git clean -fd`.
- If unrelated changes are present, leave them untouched.
