import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlainDiagnostic,
  cellPositionToShadow,
  cellRangeToShadow,
  lineToSpan,
  nearestFollowingSpan,
  isAppendedColumn,
  positionWithinSpan,
  rangeWithinSpan,
  selectionChainWithinSpan,
  shadowLinkToCell,
  shadowPositionToCell,
  shadowRangeToCell,
  spanLineBounds,
  translateDiagnostic,
} from "../src/mapping";
import { CellSpan, ShadowMapping } from "../src/transform";
import { fakeUri } from "./testUtil";

const shadowUri = fakeUri("shadow");

function makeMapping(): ShadowMapping {
  const spans: CellSpan[] = [
    { cellIndex: 0, cellUri: fakeUri("cell0"), startLine: 2, lineCount: 1 },
    { cellIndex: 1, cellUri: fakeUri("cell1"), startLine: 4, lineCount: 2 },
    { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 },
  ];
  return { headerLines: 2, spans };
}

function diag(startLine: number, startChar = 0, endLine = startLine, endChar = 5): PlainDiagnostic {
  return {
    range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
    message: "boom",
    severity: 0,
  };
}

test("lineToSpan finds the containing span", () => {
  const mapping = makeMapping();
  assert.equal(lineToSpan(mapping, 2)?.cellIndex, 0);
  assert.equal(lineToSpan(mapping, 4)?.cellIndex, 1);
  assert.equal(lineToSpan(mapping, 5)?.cellIndex, 1);
  assert.equal(lineToSpan(mapping, 8)?.cellIndex, 2);
});

test("lineToSpan returns undefined for header/marker/gap lines", () => {
  const mapping = makeMapping();
  assert.equal(lineToSpan(mapping, 0), undefined); // header
  assert.equal(lineToSpan(mapping, 1), undefined); // marker for cell 0
  assert.equal(lineToSpan(mapping, 3), undefined); // marker for cell 1
  assert.equal(lineToSpan(mapping, 6), undefined); // marker for cell 2
});

test("nearestFollowingSpan picks the next span, or the last one if none follows", () => {
  const mapping = makeMapping();
  assert.equal(nearestFollowingSpan(mapping, 0)?.cellIndex, 0);
  assert.equal(nearestFollowingSpan(mapping, 3)?.cellIndex, 1);
  assert.equal(nearestFollowingSpan(mapping, 100)?.cellIndex, 2);
});

test("positions and ranges round-trip between a cell and the shadow", () => {
  const span = makeMapping().spans[1];
  const position = { line: 1, character: 7 };
  const range = { start: { line: 0, character: 2 }, end: position };

  assert.deepEqual(cellPositionToShadow(span, position), { line: 5, character: 7 });
  assert.deepEqual(shadowPositionToCell(span, cellPositionToShadow(span, position)), position);
  assert.deepEqual(shadowRangeToCell(span, cellRangeToShadow(span, range)), range);
});

test("translateDiagnostic: in-span diagnostic is translated into cell-relative coordinates", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(5, 2, 5, 8));
  assert.ok(result);
  assert.equal(result.cellUri.toString(), mapping.spans[1].cellUri.toString());
  assert.deepEqual(result.diagnostic.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } });
  assert.equal(result.diagnostic.message, "boom");
});

test("translateDiagnostic: range end beyond the cell's real lines is clamped to the last real line", () => {
  const mapping = makeMapping();
  // span for cell 0 has lineCount 1 (startLine 2), so an end line of 3 is out of range for the span itself,
  // but the start line 2 is in-span - exercise clamping on an end that overruns lineCount.
  const result = translateDiagnostic(mapping, shadowUri, diag(2, 0, 2, 40));
  assert.ok(result);
  assert.equal(result.diagnostic.range.end.line, 0);
});

test("translateDiagnostic: outside-cell diagnostic attaches to nearest following span at (0,0)-(0,0)", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(0));
  assert.ok(result);
  assert.equal(result.cellUri.toString(), mapping.spans[0].cellUri.toString());
  assert.deepEqual(result.diagnostic.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  assert.match(result.diagnostic.message, /^\[outside cell\] /);
});

test("translateDiagnostic: outside-cell diagnostic past the last span attaches to the last span", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(50));
  assert.ok(result);
  assert.equal(result.cellUri.toString(), mapping.spans[2].cellUri.toString());
});

test("translateDiagnostic: relatedInformation in the same shadow file is translated", () => {
  const mapping = makeMapping();
  const d = diag(5);
  d.relatedInformation = [
    { uri: shadowUri, range: { start: { line: 8, character: 1 }, end: { line: 8, character: 3 } }, message: "see here" },
  ];
  const result = translateDiagnostic(mapping, shadowUri, d);
  assert.equal(result!.diagnostic.relatedInformation?.length, 1);
  const info = result!.diagnostic.relatedInformation[0];
  assert.equal(info.uri.toString(), mapping.spans[2].cellUri.toString());
  assert.equal(info.range.start.line, 1);
});

test("translateDiagnostic: relatedInformation pointing at another file is dropped", () => {
  const mapping = makeMapping();
  const d = diag(5);
  d.relatedInformation = [
    { uri: fakeUri("elsewhere"), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "elsewhere" },
  ];
  const result = translateDiagnostic(mapping, shadowUri, d);
  assert.deepEqual(result!.diagnostic.relatedInformation, []);
});

// ---------------------------------------------------------------- rangeWithinSpan

function range(startLine: number, startChar: number, endLine: number, endChar: number) {
  return { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } };
}

test("rangeWithinSpan translates a range that lies inside the span", () => {
  const span: CellSpan = { cellIndex: 1, cellUri: fakeUri("cell1"), startLine: 4, lineCount: 2 };
  assert.deepEqual(rangeWithinSpan(span, range(4, 2, 5, 7)), range(0, 2, 1, 7));
});

test("rangeWithinSpan rejects a range starting before the span", () => {
  const span: CellSpan = { cellIndex: 1, cellUri: fakeUri("cell1"), startLine: 4, lineCount: 2 };
  assert.equal(rangeWithinSpan(span, range(3, 0, 4, 1)), undefined);
});

test("rangeWithinSpan rejects a range ending after the span", () => {
  const span: CellSpan = { cellIndex: 1, cellUri: fakeUri("cell1"), startLine: 4, lineCount: 2 };
  assert.equal(rangeWithinSpan(span, range(5, 0, 6, 1)), undefined);
});

// ---------------------------------------------------------------- shadowLinkToCell

test("shadowLinkToCell maps a target in the requesting cell back to that cell", () => {
  const mapping = makeMapping();
  const link = shadowLinkToCell(mapping, { targetRange: range(4, 0, 5, 3) });
  assert.equal(link?.cellUri.fragment, "cell1");
  assert.deepEqual(link?.targetRange, range(0, 0, 1, 3));
  assert.equal(link?.targetSelectionRange, undefined);
});

test("shadowLinkToCell maps a target in a different cell to that other cell", () => {
  const mapping = makeMapping();
  const link = shadowLinkToCell(mapping, {
    targetRange: range(7, 0, 9, 1),
    targetSelectionRange: range(8, 6, 8, 9),
  });
  assert.equal(link?.cellUri.fragment, "cell2");
  assert.deepEqual(link?.targetRange, range(0, 0, 2, 1));
  assert.deepEqual(link?.targetSelectionRange, range(1, 6, 1, 9));
});

test("shadowLinkToCell picks the cell from the selection range, not the full range", () => {
  const mapping = makeMapping();
  // Full range opens on a synthesized line above the cell; the name range is what counts.
  const link = shadowLinkToCell(mapping, { targetRange: range(3, 0, 5, 1), targetSelectionRange: range(4, 4, 4, 8) });
  assert.equal(link?.cellUri.fragment, "cell1");
});

test("shadowLinkToCell returns undefined for a target outside every cell", () => {
  const mapping = makeMapping();
  // Line 6 is a cell marker between cell1 and cell2, so there is no cell to point at.
  assert.equal(shadowLinkToCell(mapping, { targetRange: range(6, 0, 6, 4) }), undefined);
});

// ---------------------------------------------------------------- positionWithinSpan

test("positionWithinSpan translates a position inside the span", () => {
  const span: CellSpan = { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 };
  assert.deepEqual(positionWithinSpan(span, { line: 8, character: 4 }), { line: 1, character: 4 });
});

test("positionWithinSpan accepts the span's first and last lines", () => {
  const span: CellSpan = { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 };
  assert.deepEqual(positionWithinSpan(span, { line: 7, character: 0 }), { line: 0, character: 0 });
  assert.deepEqual(positionWithinSpan(span, { line: 9, character: 0 }), { line: 2, character: 0 });
});

test("positionWithinSpan rejects positions on either side of the span", () => {
  const span: CellSpan = { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 };
  assert.equal(positionWithinSpan(span, { line: 6, character: 0 }), undefined);
  assert.equal(positionWithinSpan(span, { line: 10, character: 0 }), undefined);
});

// ---------------------------------------------------------------- isAppendedColumn

// `val x = "string"` is 16 characters; the shadow line reads
// `val x = "string" ; val res1_9 = (`, so Metals' hint for res1_9 lands around column 29.
test("isAppendedColumn rejects a column only the appended resN_M binding reaches", () => {
  assert.equal(isAppendedColumn({ line: 0, character: 29 }, 16), true);
});

test("isAppendedColumn accepts columns the cell line actually has, including its end", () => {
  assert.equal(isAppendedColumn({ line: 0, character: 5 }, 16), false);
  assert.equal(isAppendedColumn({ line: 0, character: 16 }, 16), false);
});

test("isAppendedColumn rejects anything past the end of a blank cell line", () => {
  // A cell whose last statement follows a blank line gets its opener appended there.
  assert.equal(isAppendedColumn({ line: 0, character: 12 }, 0), true);
  assert.equal(isAppendedColumn({ line: 0, character: 0 }, 0), false);
});

// ---------------------------------------------------------------- spanLineBounds

test("spanLineBounds covers the span's own lines", () => {
  const span: CellSpan = { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 };
  assert.deepEqual(spanLineBounds(span), { firstLine: 7, lastLine: 9 });
});

test("spanLineBounds of an empty cell stays on its start line", () => {
  const span: CellSpan = { cellIndex: 0, cellUri: fakeUri("cell0"), startLine: 4, lineCount: 0 };
  assert.deepEqual(spanLineBounds(span), { firstLine: 4, lastLine: 4 });
});

// ---------------------------------------------------------------- selectionChainWithinSpan

const chainSpan: CellSpan = { cellIndex: 1, cellUri: fakeUri("cell1"), startLine: 4, lineCount: 3 };

test("a chain wholly inside the cell is kept and translated", () => {
  const chain = [range(5, 4, 5, 7), range(5, 0, 5, 20), range(4, 0, 6, 1)];
  assert.deepEqual(selectionChainWithinSpan(chainSpan, chain), [
    range(1, 4, 1, 7),
    range(1, 0, 1, 20),
    range(0, 0, 2, 1),
  ]);
});

test("the chain is cut at the first range that escapes the cell", () => {
  // Innermost two fit; the third is the wrapper object, the fourth the whole file.
  const chain = [range(5, 4, 5, 7), range(5, 0, 5, 20), range(1, 0, 40, 0), range(0, 0, 99, 0)];
  assert.deepEqual(selectionChainWithinSpan(chainSpan, chain), [range(1, 4, 1, 7), range(1, 0, 1, 20)]);
});

test("a chain that escapes immediately keeps nothing", () => {
  assert.deepEqual(selectionChainWithinSpan(chainSpan, [range(0, 0, 99, 0)]), []);
});

test("an empty chain stays empty", () => {
  assert.deepEqual(selectionChainWithinSpan(chainSpan, []), []);
});
