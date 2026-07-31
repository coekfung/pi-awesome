/**
 * Unit tests for notebook-edit core logic (pure functions, no file I/O).
 *
 * Run with `npm test` (node:test + native TypeScript type stripping).
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import {
  detectLineEnding,
  mutateNotebook,
  normalizeNotebookPath,
  parseCellId,
  resolvePath,
  type NotebookContent,
} from "./notebook-edit.ts";

function makeNotebook(nbformat = 4, nbformat_minor = 5): NotebookContent {
  return {
    cells: [
      {
        id: "a",
        cell_type: "code",
        source: "1 + 1",
        metadata: {},
        execution_count: 2,
        outputs: [{ output_type: "stream" }],
      },
      {
        id: "b",
        cell_type: "markdown",
        source: "# Title",
        metadata: {},
      },
    ],
    metadata: {},
    nbformat,
    nbformat_minor,
  };
}

describe("parseCellId", () => {
  it("parses cell-N indices", () => {
    assert.equal(parseCellId("cell-0"), 0);
    assert.equal(parseCellId("cell-42"), 42);
    assert.equal(parseCellId("cell-007"), 7);
  });

  it("rejects non-index strings", () => {
    assert.equal(parseCellId("cell-"), undefined);
    assert.equal(parseCellId("cell-x"), undefined);
    assert.equal(parseCellId("cell-1x"), undefined);
    assert.equal(parseCellId("12"), undefined);
    assert.equal(parseCellId(""), undefined);
  });
});

describe("detectLineEnding", () => {
  it("detects LF, CRLF, and defaults to LF", () => {
    assert.equal(detectLineEnding("a\nb"), "\n");
    assert.equal(detectLineEnding("a\r\nb"), "\r\n");
    assert.equal(detectLineEnding("a\r\nb\nc"), "\r\n");
    assert.equal(detectLineEnding("no-newline"), "\n");
  });
});

describe("normalizeNotebookPath", () => {
  it("strips @ prefix", () => {
    assert.equal(normalizeNotebookPath("@x.ipynb"), "x.ipynb");
  });

  it("expands ~ and ~/", () => {
    assert.equal(normalizeNotebookPath("~"), homedir());
    assert.equal(normalizeNotebookPath("~/x.ipynb"), `${homedir()}/x.ipynb`);
  });

  it("leaves relative and absolute paths untouched", () => {
    assert.equal(normalizeNotebookPath("rel/x.ipynb"), "rel/x.ipynb");
    assert.equal(normalizeNotebookPath("/abs/x.ipynb"), "/abs/x.ipynb");
  });
});

describe("resolvePath", () => {
  it("resolves relative paths against cwd", () => {
    assert.equal(resolvePath("/tmp", "x.ipynb"), "/tmp/x.ipynb");
    assert.equal(resolvePath("/tmp", "@x.ipynb"), "/tmp/x.ipynb");
  });

  it("keeps absolute paths", () => {
    assert.equal(resolvePath("/tmp", "/abs/x.ipynb"), "/abs/x.ipynb");
  });
});

describe("mutateNotebook: replace", () => {
  it("replaces a code cell by id and clears execution state", () => {
    const notebook = makeNotebook();
    const {
      cellId,
      editMode,
      notebook: result,
    } = mutateNotebook(notebook, {
      cell_id: "a",
      new_source: "2 + 2",
    });

    assert.equal(cellId, "a");
    assert.equal(editMode, "replace");
    assert.equal(result.cells[0]!.source, "2 + 2");
    assert.equal(result.cells[0]!.execution_count, null);
    assert.deepEqual(result.cells[0]!.outputs, []);
    assert.equal(result.cells[1]!.source, "# Title");
  });

  it("replaces a markdown cell by id without adding execution fields", () => {
    const notebook = makeNotebook();
    const {
      cellId,
      editMode,
      notebook: result,
    } = mutateNotebook(notebook, {
      cell_id: "b",
      new_source: "# New",
    });

    assert.equal(cellId, "b");
    assert.equal(editMode, "replace");
    assert.equal(result.cells[1]!.source, "# New");
    assert.equal(result.cells[1]!.execution_count, undefined);
    assert.equal(result.cells[1]!.outputs, undefined);
  });

  it("replaces by cell-N index", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-1",
      new_source: "# Indexed",
    });

    assert.equal(result.cells[1]!.source, "# Indexed");
  });

  it("resolves cell ids before cell-N syntax", () => {
    const notebook: NotebookContent = {
      cells: [
        { id: "cell-1", cell_type: "code", source: "first", metadata: {} },
        { id: "x", cell_type: "code", source: "second", metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-1",
      new_source: "changed",
    });

    assert.equal(result.cells[0]!.source, "changed");
    assert.equal(result.cells[1]!.source, "second");
  });

  it("converts code to markdown and drops execution fields", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "a",
      new_source: "# Doc",
      cell_type: "markdown",
    });

    assert.equal(result.cells[0]!.cell_type, "markdown");
    assert.equal(result.cells[0]!.execution_count, undefined);
    assert.equal(result.cells[0]!.outputs, undefined);
  });

  it("converts markdown to code and initializes execution fields", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "b",
      new_source: "print(1)",
      cell_type: "code",
    });

    assert.equal(result.cells[1]!.cell_type, "code");
    assert.equal(result.cells[1]!.execution_count, null);
    assert.deepEqual(result.cells[1]!.outputs, []);
  });

  it("throws on unknown cell id", () => {
    const notebook = makeNotebook();
    assert.throws(
      () => mutateNotebook(notebook, { cell_id: "nope", new_source: "x" }),
      /not found/,
    );
  });

  it("downgrades out-of-bounds index to an append insert", () => {
    const notebook = makeNotebook();
    const { editMode, notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-2",
      new_source: "new cell",
    });

    assert.equal(editMode, "insert");
    assert.equal(result.cells.length, 3);
    assert.equal(result.cells[2]!.cell_type, "code");
    assert.equal(result.cells[2]!.source, "new cell");
  });

  it("clamps far-out-of-bounds indices before downgrading", () => {
    const notebook = makeNotebook();
    const { editMode, notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-99",
      new_source: "new cell",
    });

    assert.equal(editMode, "insert");
    assert.equal(result.cells.length, 3);
    assert.equal(result.cells[2]!.source, "new cell");
  });

  it("throws when new_source is missing", () => {
    const notebook = makeNotebook();
    assert.throws(
      () => mutateNotebook(notebook, { cell_id: "a" }),
      /new_source is required/,
    );
  });
});

describe("mutateNotebook: insert", () => {
  it("prepends when no cell_id is given", () => {
    const notebook = makeNotebook();
    const {
      cellId,
      editMode,
      notebook: result,
    } = mutateNotebook(notebook, {
      new_source: "pre",
      cell_type: "code",
      edit_mode: "insert",
    });

    assert.equal(editMode, "insert");
    assert.equal(result.cells.length, 3);
    assert.equal(result.cells[0]!.source, "pre");
    assert.equal(cellId, result.cells[0]!.id);
  });

  it("inserts after the referenced cell id", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "a",
      new_source: "mid",
      cell_type: "markdown",
      edit_mode: "insert",
    });

    assert.equal(result.cells.length, 3);
    assert.equal(result.cells[1]!.source, "mid");
    assert.equal(result.cells[2]!.id, "b");
  });

  it("inserts after a cell-N index", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-0",
      new_source: "mid",
      cell_type: "markdown",
      edit_mode: "insert",
    });

    assert.equal(result.cells[1]!.source, "mid");
  });

  it("clamps an out-of-bounds insert index to the end", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-2",
      new_source: "tail",
      cell_type: "markdown",
      edit_mode: "insert",
    });

    assert.equal(result.cells.length, 3);
    assert.equal(result.cells[2]!.source, "tail");
  });

  it("throws when cell_type is missing", () => {
    const notebook = makeNotebook();
    assert.throws(
      () =>
        mutateNotebook(notebook, {
          new_source: "x",
          edit_mode: "insert",
        }),
      /cell_type is required/,
    );
  });

  it("throws when new_source is missing", () => {
    const notebook = makeNotebook();
    assert.throws(
      () =>
        mutateNotebook(notebook, {
          cell_type: "code",
          edit_mode: "insert",
        }),
      /new_source is required/,
    );
  });

  it("gives code cells a 13-char id and empty execution state on nbformat 4.5", () => {
    const notebook = makeNotebook(4, 5);
    const { notebook: result } = mutateNotebook(notebook, {
      new_source: "print(1)",
      cell_type: "code",
      edit_mode: "insert",
    });

    const cell = result.cells[0]!;
    assert.match(cell.id ?? "", /^[0-9a-f]{13}$/);
    assert.equal(cell.execution_count, null);
    assert.deepEqual(cell.outputs, []);
  });

  it("omits ids on older nbformat versions", () => {
    for (const [major, minor] of [
      [4, 4],
      [3, 0],
    ] as const) {
      const notebook = makeNotebook(major, minor);
      const { notebook: result } = mutateNotebook(notebook, {
        new_source: "print(1)",
        cell_type: "code",
        edit_mode: "insert",
      });

      assert.equal(
        result.cells[0]!.id,
        undefined,
        `nbformat ${major}.${minor}`,
      );
    }
  });
});

describe("mutateNotebook: delete", () => {
  it("deletes a cell by id", () => {
    const notebook = makeNotebook();
    const {
      cellId,
      editMode,
      notebook: result,
    } = mutateNotebook(notebook, {
      cell_id: "a",
      edit_mode: "delete",
    });

    assert.equal(cellId, "a");
    assert.equal(editMode, "delete");
    assert.equal(result.cells.length, 1);
    assert.equal(result.cells[0]!.id, "b");
  });

  it("deletes a cell by cell-N index", () => {
    const notebook = makeNotebook();
    const { notebook: result } = mutateNotebook(notebook, {
      cell_id: "cell-1",
      edit_mode: "delete",
    });

    assert.equal(result.cells.length, 1);
    assert.equal(result.cells[0]!.id, "a");
  });

  it("throws when no cell_id is given", () => {
    const notebook = makeNotebook();
    assert.throws(
      () => mutateNotebook(notebook, { edit_mode: "delete" }),
      /not found/,
    );
  });

  it("throws on out-of-bounds index", () => {
    const notebook = makeNotebook();
    assert.throws(
      () =>
        mutateNotebook(notebook, { cell_id: "cell-2", edit_mode: "delete" }),
      /out of bounds/,
    );
  });

  it("throws on unknown cell id", () => {
    const notebook = makeNotebook();
    assert.throws(
      () => mutateNotebook(notebook, { cell_id: "nope", edit_mode: "delete" }),
      /not found/,
    );
  });
});
