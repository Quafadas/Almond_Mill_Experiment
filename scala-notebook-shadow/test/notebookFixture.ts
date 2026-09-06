import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import type { SourceCell } from "../src/transform";

/** `scala-notebook-shadow/`, resolved from the compiled `out/test/` these run from. */
export const projectRoot = path.resolve(__dirname, "..", "..");

/** The repository root, which holds `fixture/`. */
export const repoRoot = path.resolve(projectRoot, "..");

/**
 * VS Code names a notebook cell `vscode-notebook-cell:<notebook>#W<handle>sZmlsZQ==`,
 * and for a freshly opened notebook the handle is the cell's index. Reproducing that
 * here rather than inventing a fragment is what lets the golden file be byte-identical
 * to the shadow the extension actually writes into `fixture/notebook-shadow/`: the
 * fragment is echoed into each cell's `/* --- cell N <fragment> *\/` marker.
 */
function cellUri(notebookPath: string, index: number): vscode.Uri {
  const fragment = `W${index}sZmlsZQ==`;
  const text = `vscode-notebook-cell:${notebookPath}#${fragment}`;
  return { fragment, toString: () => text } as unknown as vscode.Uri;
}

interface RawCell {
  cell_type: string;
  source: string[] | string;
}

interface RawNotebook {
  cells: RawCell[];
  metadata?: { kernelspec?: { language?: string } };
}

/**
 * Read an `.ipynb` from disk as the `SourceCell[]` the transform takes, the same way
 * `ShadowManager.toSourceCells` reads an open `NotebookDocument`. Kept deliberately
 * small: it is a test fixture loader, not a second notebook implementation.
 */
export function loadNotebookCells(notebookPath: string): SourceCell[] {
  const notebook = JSON.parse(fs.readFileSync(notebookPath, "utf8")) as RawNotebook;
  const kernelLanguage = notebook.metadata?.kernelspec?.language ?? "scala";

  return notebook.cells.map((cell, index) => {
    const isCode = cell.cell_type === "code";
    return {
      index,
      isCode,
      languageId: isCode ? kernelLanguage : "markdown",
      text: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
      uri: cellUri(notebookPath, index),
    };
  });
}
