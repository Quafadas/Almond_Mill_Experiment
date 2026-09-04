import type * as vscode from "vscode";

/**
 * Pure transform: notebook cells -> shadow file text + line mapping.
 * Deliberately free of any VS Code runtime dependency (only type-only
 * imports for the Uri type) so it can be unit tested with plain
 * `node --test`, without an extension host.
 */

export interface ScalaNotebookConfig {
  scalaVersion: string;
  mvnDeps: string[];
  preamble: string[];
}

/** A minimal, decoupled view of a notebook cell used as transform input. */
export interface SourceCell {
  /** Index of this cell in notebook.getCells(). */
  index: number;
  isCode: boolean;
  languageId: string;
  text: string;
  uri: vscode.Uri;
}

export interface CellSpan {
  cellIndex: number;
  cellUri: vscode.Uri;
  /** 0-based line in the shadow file where this cell's first content line starts. */
  startLine: number;
  /** Real lines belonging to this cell (excludes any synthesized trailing newline). */
  lineCount: number;
}

export interface ShadowMapping {
  /** Number of lines occupied by the header + preamble, before the first cell marker. */
  headerLines: number;
  /** Spans sorted ascending by startLine. */
  spans: CellSpan[];
}

export interface TransformResult {
  text: string;
  mapping: ShadowMapping;
}

const IVY_IMPORT_RE = /^\s*import\s+\$ivy\.`([^`]+)`\s*$/;

/** Split cell text into its real document lines, dropping one synthesized trailing empty line. */
function realLines(text: string): string[] {
  const hadTrailingNewline = text.endsWith("\n");
  const raw = text.split("\n");
  if (hadTrailingNewline) {
    // text.split("\n") on "foo\nbar\n" yields ["foo","bar",""] - the trailing ""
    // is not a real document line, it's just where the trailing newline landed.
    raw.pop();
  }
  return raw;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export function selectScalaCodeCells(cells: SourceCell[]): SourceCell[] {
  return cells.filter((c) => c.isCode && c.languageId === "scala");
}

export function transform(cells: SourceCell[], config: ScalaNotebookConfig): TransformResult {
  const codeCells = selectScalaCodeCells(cells);

  const rewrittenPerCell: string[][] = [];
  const ivyDeps: string[] = [];
  for (const cell of codeCells) {
    const lines = realLines(cell.text);
    const rewritten = lines.map((line) => {
      const m = IVY_IMPORT_RE.exec(line);
      if (m) {
        const dep = m[1];
        if (!ivyDeps.includes(dep)) {
          ivyDeps.push(dep);
        }
        return `// [shadow] ${line}`;
      }
      return line;
    });
    rewrittenPerCell.push(rewritten);
  }

  const allDeps = dedupe([...config.mvnDeps, ...ivyDeps]);

  const headerLines: string[] = [`//| scalaVersion: ${config.scalaVersion}`];
  if (allDeps.length > 0) {
    headerLines.push("//| mvnDeps:");
    for (const dep of allDeps) {
      headerLines.push(`//| - ${dep}`);
    }
  }

  const preambleLines = config.preamble.slice();
  const outLines: string[] = [...headerLines, ...preambleLines];
  const spans: CellSpan[] = [];

  codeCells.forEach((cell, i) => {
    const lines = rewrittenPerCell[i];
    outLines.push(`// --- cell ${cell.index} ${cell.uri.fragment}`);
    const startLine = outLines.length;
    for (const line of lines) {
      outLines.push(line);
    }
    spans.push({
      cellIndex: cell.index,
      cellUri: cell.uri,
      startLine,
      lineCount: lines.length,
    });
  });

  const text = outLines.join("\n") + "\n";

  return {
    text,
    mapping: {
      headerLines: headerLines.length + preambleLines.length,
      spans,
    },
  };
}
