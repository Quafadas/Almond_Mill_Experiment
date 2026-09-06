import type * as vscode from "vscode";
import type { CellSpan, ShadowMapping } from "./transform";

/**
 * Pure diagnostic-translation logic: shadow-file line/range -> cell-relative
 * line/range. Kept free of any VS Code runtime dependency (only type-only
 * imports) so it is unit testable with plain `node --test`.
 */

export interface PlainPosition {
  line: number;
  character: number;
}

export interface PlainRange {
  start: PlainPosition;
  end: PlainPosition;
}

export interface PlainRelatedInformation {
  uri: vscode.Uri;
  range: PlainRange;
  message: string;
}

export interface PlainDiagnostic {
  range: PlainRange;
  message: string;
  severity: number;
  source?: string;
  code?: string | number | { value: string | number; target: vscode.Uri };
  tags?: number[];
  relatedInformation?: PlainRelatedInformation[];
}

export interface TranslatedDiagnostic {
  cellUri: vscode.Uri;
  diagnostic: PlainDiagnostic;
}

/** Shift a range by whole lines, clamping at the top of the file. */
export function rebaseRange(range: PlainRange, lineDelta: number): PlainRange {
  return {
    start: { line: Math.max(range.start.line + lineDelta, 0), character: range.start.character },
    end: { line: Math.max(range.end.line + lineDelta, 0), character: range.end.character },
  };
}

/**
 * Translate a diagnostic reported against Mill's generated copy of a shadow script into
 * the shadow file's own coordinates, so the rest of the pipeline never has to know the
 * copy exists. Self-referencing relatedInformation is re-pointed at the shadow file too.
 */
export function rebaseDiagnostic(
  diagnostic: PlainDiagnostic,
  generatedUri: vscode.Uri,
  shadowUri: vscode.Uri,
  lineOffset: number
): PlainDiagnostic {
  const generatedKey = generatedUri.toString();
  return {
    ...diagnostic,
    range: rebaseRange(diagnostic.range, -lineOffset),
    relatedInformation: diagnostic.relatedInformation?.map((info) =>
      info.uri.toString() === generatedKey
        ? { uri: shadowUri, range: rebaseRange(info.range, -lineOffset), message: info.message }
        : info
    ),
  };
}

/** Shift a position by whole lines, clamping at the top of the file. */
export function rebasePosition(position: PlainPosition, lineDelta: number): PlainPosition {
  return { line: Math.max(position.line + lineDelta, 0), character: position.character };
}

export function cellPositionToShadow(span: CellSpan, position: PlainPosition): PlainPosition {
  return { line: span.startLine + position.line, character: position.character };
}

export function shadowPositionToCell(span: CellSpan, position: PlainPosition): PlainPosition {
  return { line: position.line - span.startLine, character: position.character };
}

export function cellRangeToShadow(span: CellSpan, range: PlainRange): PlainRange {
  return {
    start: cellPositionToShadow(span, range.start),
    end: cellPositionToShadow(span, range.end),
  };
}

export function shadowRangeToCell(span: CellSpan, range: PlainRange): PlainRange {
  return {
    start: shadowPositionToCell(span, range.start),
    end: shadowPositionToCell(span, range.end),
  };
}

/** Binary search: find the span that contains shadowLine, if any. Spans must be sorted by startLine. */
export function lineToSpan(mapping: ShadowMapping, shadowLine: number): CellSpan | undefined {
  const spans = mapping.spans;
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (shadowLine < span.startLine) {
      hi = mid - 1;
    } else if (shadowLine >= span.startLine + span.lineCount) {
      lo = mid + 1;
    } else {
      return span;
    }
  }
  return undefined;
}

/** The nearest span starting at or after shadowLine, falling back to the last span. */
export function nearestFollowingSpan(mapping: ShadowMapping, shadowLine: number): CellSpan | undefined {
  for (const span of mapping.spans) {
    if (span.startLine >= shadowLine) {
      return span;
    }
  }
  return mapping.spans.length > 0 ? mapping.spans[mapping.spans.length - 1] : undefined;
}

function clampToSpan(span: CellSpan, pos: PlainPosition): PlainPosition {
  const maxLine = Math.max(span.lineCount - 1, 0);
  if (pos.line > maxLine) {
    return { line: maxLine, character: 0 };
  }
  return pos;
}

function translateRangeIntoSpan(span: CellSpan, range: PlainRange): PlainRange {
  const start = clampToSpan(span, { line: range.start.line - span.startLine, character: range.start.character });
  const end = clampToSpan(span, { line: range.end.line - span.startLine, character: range.end.character });
  return { start, end };
}

/**
 * Translate one shadow-file diagnostic into a (cellUri, cell-relative diagnostic) pair.
 *
 * - A diagnostic landing inside a span is translated into that cell's coordinate space.
 * - A diagnostic outside every span (header/marker/synthesized lines) is attached to the
 *   nearest following span at (0,0)-(0,0), with its message prefixed "[outside cell] ".
 * - relatedInformation pointing at the same shadow file is translated if it lands in a
 *   span, otherwise dropped.
 */
export function translateDiagnostic(
  mapping: ShadowMapping,
  shadowUri: vscode.Uri,
  diagnostic: PlainDiagnostic
): TranslatedDiagnostic | undefined {
  const span = lineToSpan(mapping, diagnostic.range.start.line);

  if (span) {
    const relatedInformation = diagnostic.relatedInformation
      ?.map((info) => translateRelatedInformation(mapping, shadowUri, info))
      .filter((info): info is PlainRelatedInformation => info !== undefined);

    return {
      cellUri: span.cellUri,
      diagnostic: {
        ...diagnostic,
        range: translateRangeIntoSpan(span, diagnostic.range),
        relatedInformation,
      },
    };
  }

  const fallback = nearestFollowingSpan(mapping, diagnostic.range.start.line);
  if (!fallback) {
    return undefined;
  }

  return {
    cellUri: fallback.cellUri,
    diagnostic: {
      ...diagnostic,
      message: `[outside cell] ${diagnostic.message}`,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      relatedInformation: undefined,
    },
  };
}

function translateRelatedInformation(
  mapping: ShadowMapping,
  shadowUri: vscode.Uri,
  info: PlainRelatedInformation
): PlainRelatedInformation | undefined {
  if (info.uri.toString() !== shadowUri.toString()) {
    // Points at some other file; nothing to translate, and we can't safely rewrite
    // its range, so drop it rather than emit a misleading location.
    return undefined;
  }
  const span = lineToSpan(mapping, info.range.start.line);
  if (!span) {
    return undefined;
  }
  return {
    uri: span.cellUri,
    range: translateRangeIntoSpan(span, info.range),
    message: info.message,
  };
}

/** Group translated diagnostics by cell URI (as a string key) for DiagnosticCollection.set(). */
export function groupByCellUri(translated: TranslatedDiagnostic[]): Map<string, PlainDiagnostic[]> {
  const grouped = new Map<string, PlainDiagnostic[]>();
  for (const { cellUri, diagnostic } of translated) {
    const key = cellUri.toString();
    const list = grouped.get(key);
    if (list) {
      list.push(diagnostic);
    } else {
      grouped.set(key, [diagnostic]);
    }
  }
  return grouped;
}

/**
 * `range` expressed in `span`'s cell coordinates, or undefined if it isn't wholly inside
 * the span. Language-feature results cover the whole shadow file, but a cell is its own
 * document, so anything reaching outside it has no coordinates we can honestly report.
 */
export function rangeWithinSpan(span: CellSpan, range: PlainRange): PlainRange | undefined {
  const lastLine = span.startLine + span.lineCount - 1;
  if (range.start.line < span.startLine || range.end.line > lastLine) {
    return undefined;
  }
  return shadowRangeToCell(span, range);
}

/**
 * The part of a selection chain that a cell can express. Chains arrive innermost first, each
 * range containing the one before it; expanding a selection in the shadow eventually reaches
 * the wrapper object and then the whole file, which are real parents there but nothing the
 * cell can select. Cutting at the first range that doesn't fit leaves "expand selection"
 * stopping at the cell boundary, and keeps what remains properly nested.
 */
export function selectionChainWithinSpan(span: CellSpan, chain: PlainRange[]): PlainRange[] {
  const kept: PlainRange[] = [];
  for (const range of chain) {
    const within = rangeWithinSpan(span, range);
    if (!within) {
      break;
    }
    kept.push(within);
  }
  return kept;
}

/** The shadow-side shape of a definition-like result: a target range plus an optional name range. */
export interface ShadowLocationLink {
  targetRange: PlainRange;
  targetSelectionRange?: PlainRange;
}

export interface CellLocationLink {
  cellUri: vscode.Uri;
  targetRange: PlainRange;
  targetSelectionRange?: PlainRange;
}

/**
 * Translate a definition/implementation/reference target that lands in a shadow script back
 * to the notebook cell it was generated from.
 *
 * `lineOffset` is how far the file the target was reported against sits below the shadow
 * file - non-zero when Metals resolved into Mill's generated `.dest/` copy. Returns
 * undefined when the target lands outside every cell (the header, a cell marker, a
 * synthesized `resN_M` binding), which the caller should treat as "leave the result alone".
 */
export function shadowLinkToCell(
  mapping: ShadowMapping,
  link: ShadowLocationLink,
  lineOffset: number
): CellLocationLink | undefined {
  const targetRange = rebaseRange(link.targetRange, -lineOffset);
  const targetSelectionRange = link.targetSelectionRange
    ? rebaseRange(link.targetSelectionRange, -lineOffset)
    : undefined;

  // Prefer the name range to decide which cell owns the target: a definition's full range
  // can start on a line the cell doesn't own (a leading annotation, say).
  const span = lineToSpan(mapping, (targetSelectionRange ?? targetRange).start.line);
  if (!span) {
    return undefined;
  }
  return {
    cellUri: span.cellUri,
    targetRange: shadowRangeToCell(span, targetRange),
    targetSelectionRange: targetSelectionRange ? shadowRangeToCell(span, targetSelectionRange) : undefined,
  };
}

/**
 * `position` expressed in `span`'s cell coordinates, or undefined if it falls outside the
 * span - a synthesized line the cell has no coordinates for.
 */
export function positionWithinSpan(span: CellSpan, position: PlainPosition): PlainPosition | undefined {
  if (position.line < span.startLine || position.line >= span.startLine + span.lineCount) {
    return undefined;
  }
  return shadowPositionToCell(span, position);
}

/**
 * The shadow-file lines a cell occupies. Only the lines: the end column has to come from
 * the shadow document itself, since a request range reaching past the end of a line is not
 * a range any provider is obliged to answer sensibly.
 */
export function spanLineBounds(span: CellSpan): { firstLine: number; lastLine: number } {
  return {
    firstLine: span.startLine,
    lastLine: Math.max(span.startLine + span.lineCount - 1, span.startLine),
  };
}

/**
 * True when a cell-relative `position` lands past the end of the cell's own line, i.e. in
 * text the transform appended to the shadow line and the cell never had: a `resN_M` result
 * binding, or the `)` that closes one.
 *
 * `planResultBindings` puts a statement's opener on the end of the line *before* it, so a
 * result reported at those columns belongs to the synthesized binding, not to the statement
 * the user wrote there. The cell has no such column, so VS Code clamps the position to the
 * end of the line and renders the result against the previous statement - which is how an
 * inlay hint for `resN_M` shows up as the type of the line above it.
 */
export function isAppendedColumn(position: PlainPosition, cellLineLength: number): boolean {
  return position.character > cellLineLength;
}
