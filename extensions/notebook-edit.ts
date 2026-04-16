/**
 * Notebook Edit Extension
 *
 * Adds a `notebook_edit` tool to pi-coding-agent for editing Jupyter notebooks
 * (.ipynb). Supports replace, insert, and delete operations on individual cells.
 *
 * Usage:
 * 1. Install: `pi install git:github.com/coekfung/pi-awesome`
 * 2. The tool is automatically available to the model.
 *
 * Design notes (clean-room from Claude Code's NotebookEditTool):
 * - Cell lookup by id first, then falls back to `cell-N` index notation.
 * - Insert places the new cell *after* the referenced cell.
 * - Replace beyond the last cell auto-downgrades to insert.
 * - Editing a code cell clears its execution_count and outputs.
 * - New cells get a random id when nbformat >= 4.5.
 * - The tool requires the notebook to have been read by the built-in `read`
 *   tool first, and rejects the edit if the file changed on disk since then.
 */

import { randomUUID } from "node:crypto";
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type NotebookCell = {
  id?: string;
  cell_type: "code" | "markdown";
  source: string | string[];
  metadata?: Record<string, any>;
  execution_count?: number | null;
  outputs?: any[];
};

type NotebookContent = {
  cells: NotebookCell[];
  metadata: {
    language_info?: { name?: string };
    [key: string]: any;
  };
  nbformat: number;
  nbformat_minor: number;
};

const notebookEditSchema = Type.Object(
  {
    notebook_path: Type.String({
      description:
        "Path to the .ipynb file to edit (absolute or relative to cwd)",
    }),
    cell_id: Type.Optional(
      Type.String({
        description:
          "ID of the cell to edit. When inserting, the new cell is inserted after this ID. Omit to insert at the beginning.",
      }),
    ),
    new_source: Type.Optional(
      Type.String({
        description:
          "New source content for the cell. Not needed when edit_mode is 'delete'.",
      }),
    ),
    cell_type: Type.Optional(
      Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
        description: "Type of the cell. Required when edit_mode is 'insert'.",
      }),
    ),
    edit_mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("replace"),
          Type.Literal("insert"),
          Type.Literal("delete"),
        ],
        {
          description: "Edit operation to perform. Defaults to 'replace'.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/);
  if (match?.[1]) {
    const index = Number.parseInt(match[1], 10);
    return Number.isNaN(index) ? undefined : index;
  }
  return undefined;
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function generateCellId(): string {
  return randomUUID().replace(/-/g, "").substring(0, 13);
}

class ReadGuard {
  private cache = new Map<string, string>();
  private pendingReads = new Set<string>();

  attach(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx: ExtensionContext) => {
      if (event.toolName === "read") {
        const input = event.input as { path?: string };
        if (input.path?.endsWith(".ipynb")) {
          const resolved = resolvePath(ctx.cwd, input.path);
          this.pendingReads.add(resolved);
          this.cache.set(resolved, "");
        }
      }
    });

    pi.on("tool_result", async (event, ctx: ExtensionContext) => {
      if (event.toolName !== "read") return;
      if (event.isError) return;

      const path = (event.input as { path?: string }).path;
      if (!path?.endsWith(".ipynb")) return;

      const resolved = resolvePath(ctx.cwd, path);
      const textParts = event.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text);
      this.pendingReads.delete(resolved);
      this.cache.set(resolved, textParts.join(""));
    });
  }

  check(
    path: string,
  ): { ok: true; cached: string } | { ok: false; reason: string } {
    const cached = this.cache.get(path);
    if (cached === undefined) {
      return {
        ok: false,
        reason: "Notebook has not been read yet. Read it first before editing.",
      };
    }
    if (cached === "" || this.pendingReads.has(path)) {
      return {
        ok: false,
        reason:
          "Notebook read is pending. Wait for the read tool to complete before editing.",
      };
    }
    return { ok: true, cached };
  }

  update(path: string, content: string) {
    this.cache.set(path, content);
  }
}

function mutateNotebook(
  notebook: NotebookContent,
  params: {
    cell_id?: string;
    new_source?: string;
    cell_type?: "code" | "markdown";
    edit_mode?: "replace" | "insert" | "delete";
  },
): {
  cellId: string | undefined;
  editMode: "replace" | "insert" | "delete";
  notebook: NotebookContent;
} {
  let { cell_id, new_source, cell_type, edit_mode } = params;
  edit_mode = edit_mode ?? "replace";

  let cellIndex = -1;
  if (cell_id === undefined) {
    cellIndex = edit_mode === "insert" ? 0 : -1;
  } else {
    cellIndex = notebook.cells.findIndex((c) => c.id === cell_id);
    if (cellIndex === -1) {
      const parsed = parseCellId(cell_id);
      if (parsed !== undefined) {
        cellIndex = parsed;
      }
    }
  }

  if (cellIndex === -1) {
    throw new Error(
      `Cell with ID or index "${cell_id}" not found in notebook.`,
    );
  }

  if (edit_mode === "insert" && cell_id !== undefined) {
    cellIndex += 1;
  }

  if (cellIndex < 0) cellIndex = 0;
  if (cellIndex > notebook.cells.length) cellIndex = notebook.cells.length;

  if (edit_mode === "replace" && cellIndex === notebook.cells.length) {
    edit_mode = "insert";
    if (!cell_type) cell_type = "code";
  }

  const needsId =
    notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);
  let newCellId: string | undefined;

  if (edit_mode === "delete") {
    if (cellIndex >= notebook.cells.length) {
      throw new Error(
        `Cannot delete: cell index ${cellIndex} is out of bounds.`,
      );
    }
    notebook.cells.splice(cellIndex, 1);
    newCellId = cell_id;
  } else if (edit_mode === "insert") {
    if (!cell_type) {
      throw new Error("cell_type is required when edit_mode is 'insert'.");
    }
    if (new_source === undefined) {
      throw new Error("new_source is required when edit_mode is 'insert'.");
    }
    newCellId = needsId ? generateCellId() : undefined;
    const newCell: NotebookCell =
      cell_type === "markdown"
        ? {
            cell_type: "markdown",
            id: newCellId,
            source: new_source,
            metadata: {},
          }
        : {
            cell_type: "code",
            id: newCellId,
            source: new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          };
    notebook.cells.splice(cellIndex, 0, newCell);
  } else {
    if (cellIndex >= notebook.cells.length) {
      throw new Error(
        `Cell with ID or index "${cell_id ?? cellIndex}" not found in notebook.`,
      );
    }
    if (new_source === undefined) {
      throw new Error("new_source is required when edit_mode is 'replace'.");
    }
    const target = notebook.cells[cellIndex]!;
    target.source = new_source;
    if (target.cell_type === "code") {
      target.execution_count = null;
      target.outputs = [];
    }
    if (cell_type && cell_type !== target.cell_type) {
      target.cell_type = cell_type;
      if (target.cell_type === "code") {
        target.execution_count = null;
        target.outputs = [];
      } else {
        delete target.execution_count;
        delete target.outputs;
      }
    }
    newCellId = target.id ?? cell_id;
  }

  return { cellId: newCellId, editMode: edit_mode, notebook };
}

export default function (pi: ExtensionAPI) {
  const guard = new ReadGuard();
  guard.attach(pi);

  pi.registerTool({
    name: "notebook_edit",
    label: "Notebook Edit",
    description:
      "Replace, insert, or delete a cell in a Jupyter notebook (.ipynb). " +
      "The notebook must be read with the read tool first. " +
      "Use cell_id to identify the target cell (exact id or cell-N index).",
    promptSnippet: "Edit Jupyter notebook cells",
    promptGuidelines: [
      "Always read the notebook with the read tool before calling notebook_edit.",
      "Use the cell's id attribute from the read output as cell_id when possible.",
      "If no id is present, use cell-N where N is the 0-based index.",
      "For insert, the new cell is placed after the cell specified by cell_id.",
    ],
    parameters: notebookEditSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const fullPath = resolvePath(ctx.cwd, params.notebook_path);

      if (!fullPath.endsWith(".ipynb")) {
        throw new Error("File must be a Jupyter notebook (.ipynb).");
      }

      const guardResult = guard.check(fullPath);
      if (!guardResult.ok) {
        throw new Error(guardResult.reason);
      }

      const raw = await fsReadFile(fullPath, "utf-8");
      if (raw !== guardResult.cached) {
        throw new Error(
          "Notebook was modified since it was last read. Read it again before editing.",
        );
      }

      let notebook: NotebookContent;
      try {
        notebook = JSON.parse(raw) as NotebookContent;
      } catch {
        throw new Error("Notebook is not valid JSON.");
      }

      if (!Array.isArray(notebook.cells)) {
        throw new Error("Invalid notebook structure: missing cells array.");
      }

      const {
        cellId,
        editMode,
        notebook: mutated,
      } = mutateNotebook(notebook, {
        cell_id: params.cell_id,
        new_source: params.new_source,
        cell_type: params.cell_type,
        edit_mode: params.edit_mode,
      });

      const lineEnding = detectLineEnding(raw);
      const updated =
        JSON.stringify(mutated, null, 1).replace(/\n/g, lineEnding) +
        lineEnding;
      await fsWriteFile(fullPath, updated, "utf-8");

      guard.update(fullPath, updated);

      const language = mutated.metadata.language_info?.name ?? "python";
      const displayPath = basename(fullPath);

      let text: string;
      switch (editMode) {
        case "insert":
          text = `Inserted ${params.cell_type} cell ${cellId ? `"${cellId}" ` : ""}into ${displayPath}`;
          break;
        case "delete":
          text = `Deleted cell ${params.cell_id ? `"${params.cell_id}" ` : ""}from ${displayPath}`;
          break;
        default:
          text = `Updated cell ${cellId ? `"${cellId}" ` : ""}in ${displayPath}`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          path: fullPath,
          cell_id: cellId,
          edit_mode: editMode,
          language,
        },
      };
    },

    renderCall(args, theme) {
      const pathDisplay = args.notebook_path
        ? basename(args.notebook_path)
        : "?";
      const mode = args.edit_mode ?? "replace";
      const target = args.cell_id ?? (mode === "insert" ? "start" : "?");
      const label = `${pathDisplay} @${target} [${mode}]`;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("notebook_edit"))} ${theme.fg("accent", label)}`,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as {
        path?: string;
        cell_id?: string;
        edit_mode?: string;
        language?: string;
      };
      const mode = details.edit_mode ?? "replace";
      let text: string;
      switch (mode) {
        case "insert":
          text = `Inserted cell "${details.cell_id ?? "?"}"`;
          break;
        case "delete":
          text = `Deleted cell "${details.cell_id ?? "?"}"`;
          break;
        default:
          text = `Updated cell "${details.cell_id ?? "?"}"`;
      }
      return new Text(theme.fg("success", text));
    },
  });
}
