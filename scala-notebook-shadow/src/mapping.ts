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
