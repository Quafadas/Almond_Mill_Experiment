import assert from "node:assert/strict";
import { test } from "node:test";
import { lineToSpan, nearestFollowingSpan, PlainDiagnostic, translateDiagnostic } from "../src/mapping";
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

test("translateDiagnostic: in-span diagnostic is translated into cell-relative coordinates", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(5, 2, 5, 8));
  assert.ok(result);
  assert.equal(result!.cellUri.toString(), mapping.spans[1].cellUri.toString());
  assert.deepEqual(result!.diagnostic.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } });
  assert.equal(result!.diagnostic.message, "boom");
});

test("translateDiagnostic: range end beyond the cell's real lines is clamped to the last real line", () => {
  const mapping = makeMapping();
  // span for cell 0 has lineCount 1 (startLine 2), so an end line of 3 is out of range for the span itself,
  // but the start line 2 is in-span - exercise clamping on an end that overruns lineCount.
  const result = translateDiagnostic(mapping, shadowUri, diag(2, 0, 2, 40));
  assert.ok(result);
  assert.equal(result!.diagnostic.range.end.line, 0);
});

test("translateDiagnostic: outside-cell diagnostic attaches to nearest following span at (0,0)-(0,0)", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(0));
  assert.ok(result);
  assert.equal(result!.cellUri.toString(), mapping.spans[0].cellUri.toString());
  assert.deepEqual(result!.diagnostic.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
  assert.match(result!.diagnostic.message, /^\[outside cell\] /);
});

test("translateDiagnostic: outside-cell diagnostic past the last span attaches to the last span", () => {
  const mapping = makeMapping();
  const result = translateDiagnostic(mapping, shadowUri, diag(50));
  assert.ok(result);
  assert.equal(result!.cellUri.toString(), mapping.spans[2].cellUri.toString());
});

test("translateDiagnostic: relatedInformation in the same shadow file is translated", () => {
  const mapping = makeMapping();
  const d = diag(5);
  d.relatedInformation = [
    { uri: shadowUri, range: { start: { line: 8, character: 1 }, end: { line: 8, character: 3 } }, message: "see here" },
  ];
  const result = translateDiagnostic(mapping, shadowUri, d);
  assert.equal(result!.diagnostic.relatedInformation?.length, 1);
  const info = result!.diagnostic.relatedInformation![0];
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
