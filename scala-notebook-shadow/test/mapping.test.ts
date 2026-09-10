import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlainDiagnostic,
  PlainTextEdit,
  cellPositionToShadow,
  cellRangeToShadow,
  lineToSpan,
  minimalTextEdit,
  nearestFollowingSpan,
  offsetToPosition,
  isAppendedColumn,
  positionWithinSpan,
  rangeWithinSpan,
  rangesWithinSpan,
  selectionChainWithinSpan,
  shadowEditsToCells,
  shadowHierarchyItemToCell,
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

function edit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText = "x"
): PlainTextEdit {
  return {
    range: { start: { line: startLine, character: startChar }, end: { line: endLine, character: endChar } },
    newText,
  };
}

/** An insertion, which is the only shape an out-of-cell edit is ever hoisted for. */
function insertion(line: number, character: number, newText: string): PlainTextEdit {
  return { range: { start: { line, character }, end: { line, character } }, newText };
}

test("shadowEditsToCells translates an edit inside a cell into cell coordinates", () => {
  const mapping = makeMapping();
  const result = shadowEditsToCells(mapping, [edit(5, 2, 5, 8, "renamed")]);

  assert.equal(result?.cells.length, 1);
  assert.equal(result?.hoisted, 0);
  assert.equal(result?.cells[0].cellUri.toString(), fakeUri("cell1").toString());
  assert.deepEqual(result?.cells[0].edits, [
    { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }, newText: "renamed" },
  ]);
});

test("shadowEditsToCells groups edits by cell, in the order the cells first appear", () => {
  const mapping = makeMapping();
  const result = shadowEditsToCells(mapping, [edit(8, 0, 8, 1, "b"), edit(2, 0, 2, 1, "a"), edit(9, 0, 9, 1, "c")]);

  assert.deepEqual(
    result?.cells.map((cell) => cell.cellUri.toString()),
    [fakeUri("cell2").toString(), fakeUri("cell0").toString()]
  );
  assert.deepEqual(
    result?.cells[0].edits.map((e) => [e.range.start.line, e.newText]),
    [
      [1, "b"],
      [2, "c"],
    ]
  );
});

test("shadowEditsToCells rejects an edit that starts in a cell and reaches past its end", () => {
  const mapping = makeMapping();
  // cell1 owns lines 4-5; line 6 is the marker for cell2.
  assert.equal(shadowEditsToCells(mapping, [edit(5, 0, 6, 3)]), undefined);
});

test("shadowEditsToCells rejects an edit outside every cell when there is nowhere to hoist it", () => {
  const mapping = makeMapping();
  assert.equal(shadowEditsToCells(mapping, [insertion(0, 0, "import foo.Bar\n")]), undefined);
});

test("shadowEditsToCells hoists an out-of-cell insertion to the top of the given cell", () => {
  const mapping = makeMapping();
  const result = shadowEditsToCells(mapping, [insertion(1, 0, "import foo.Bar\n")], mapping.spans[2]);

  assert.equal(result?.hoisted, 1);
  assert.equal(result?.cells[0].cellUri.toString(), fakeUri("cell2").toString());
  assert.deepEqual(result?.cells[0].edits, [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      newText: "import foo.Bar\n",
    },
  ]);
});

test("shadowEditsToCells refuses to hoist a replacement, which would move generated text into a cell", () => {
  const mapping = makeMapping();
  // What "organize imports" looks like: rewriting the prelude rather than inserting into it.
  assert.equal(shadowEditsToCells(mapping, [edit(0, 0, 1, 0, "import a.b\n")], mapping.spans[2]), undefined);
});

test("shadowEditsToCells rejects an out-of-cell edit that reaches into a cell", () => {
  const mapping = makeMapping();
  // Starts on cell1's marker line and ends inside cell1: hoisting it would duplicate the
  // cell text it swallows, so it is not hoistable however empty its start looks.
  assert.equal(shadowEditsToCells(mapping, [edit(3, 0, 4, 2)], mapping.spans[1]), undefined);
});

test("shadowEditsToCells puts a hoisted insertion and the cell's own edits on one cell", () => {
  const mapping = makeMapping();
  const result = shadowEditsToCells(
    mapping,
    [insertion(0, 0, "import foo.Bar\n"), edit(8, 4, 8, 7, "Bar")],
    mapping.spans[2]
  );

  assert.equal(result?.cells.length, 1);
  assert.equal(result?.hoisted, 1);
  assert.deepEqual(
    result?.cells[0].edits.map((e) => [e.range.start.line, e.range.start.character, e.newText]),
    [
      [0, 0, "import foo.Bar\n"],
      [1, 4, "Bar"],
    ]
  );
});

test("shadowEditsToCells accepts an empty edit list", () => {
  assert.deepEqual(shadowEditsToCells(makeMapping(), []), { cells: [], hoisted: 0 });
});

test("offsetToPosition counts lines and the offset into the last one", () => {
  const text = "one\ntwo\nthree";
  assert.deepEqual(offsetToPosition(text, 0), { line: 0, character: 0 });
  assert.deepEqual(offsetToPosition(text, 3), { line: 0, character: 3 });
  assert.deepEqual(offsetToPosition(text, 4), { line: 1, character: 0 });
  assert.deepEqual(offsetToPosition(text, 10), { line: 2, character: 2 });
  assert.deepEqual(offsetToPosition(text, text.length), { line: 2, character: 5 });
});

test("minimalTextEdit reports nothing when the text is unchanged", () => {
  assert.equal(minimalTextEdit("val x = 1\n", "val x = 1\n"), undefined);
});

test("minimalTextEdit recovers an inferred type as an insertion", () => {
  // What "insert inferred type" does to the shadow, and the whole point of the diff.
  const edit = minimalTextEdit("a\nval x = 1\nb\n", "a\nval x: Int = 1\nb\n");
  assert.deepEqual(edit, {
    range: { start: { line: 1, character: 5 }, end: { line: 1, character: 5 } },
    newText: ": Int",
  });
});

test("minimalTextEdit recovers a replacement, trimmed to what actually differs", () => {
  // The trailing " 2)" is common to both, so the range stops short of it.
  const edit = minimalTextEdit("val x = foo(1, 2)\n", "val x = foo(a = 1, b = 2)\n");
  assert.deepEqual(edit, {
    range: { start: { line: 0, character: 12 }, end: { line: 0, character: 14 } },
    newText: "a = 1, b =",
  });
});

test("minimalTextEdit recovers a deletion", () => {
  // "t" is common to "two" and "three", so the cut starts after it and ends after "two\nt".
  const edit = minimalTextEdit("one\ntwo\nthree\n", "one\nthree\n");
  assert.deepEqual(edit, {
    range: { start: { line: 1, character: 1 }, end: { line: 2, character: 1 } },
    newText: "",
  });
});

test("minimalTextEdit spans every change when a command touched two places", () => {
  // Extract-method shape: a new definition above and a rewritten call below. One range
  // covering both is what lets shadowEditsToCells reject it if it crosses a cell boundary.
  const edit = minimalTextEdit("head\nuse 1 + 2\ntail\n", "head\ndef m = 1 + 2\nuse m\ntail\n");
  assert.deepEqual(edit, {
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
    newText: "def m = 1 + 2\nuse m",
  });
});

test("minimalTextEdit handles an append with no common suffix", () => {
  const edit = minimalTextEdit("a\n", "a\nb\n");
  assert.deepEqual(edit, {
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
    newText: "b\n",
  });
});

// ---------------------------------------------------------------- hierarchy items

test("shadowHierarchyItemToCell places an item in the cell that owns it", () => {
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "add",
    range: range(7, 0, 9, 1),
    selectionRange: range(7, 4, 7, 8),
  });
  assert.equal(placed?.cellUri.fragment, "cell2");
  assert.equal(placed?.span.cellIndex, 2);
  assert.deepEqual(placed?.range, range(0, 0, 2, 1));
  assert.deepEqual(placed?.selectionRange, range(0, 4, 0, 8));
});

test("shadowHierarchyItemToCell decides ownership by the name range", () => {
  // A declaration whose range opens on a line the cell doesn't own - an annotation the
  // transform put above it - still belongs to the cell its name is written in.
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "add",
    range: range(3, 0, 5, 1),
    selectionRange: range(4, 4, 4, 7),
  });
  assert.equal(placed?.cellUri.fragment, "cell1");
  assert.deepEqual(placed?.selectionRange, range(0, 4, 0, 7));
});

test("shadowHierarchyItemToCell falls back to the name range when the cell can't hold the whole item", () => {
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "add",
    range: range(3, 0, 5, 1),
    selectionRange: range(4, 4, 4, 7),
  });
  // VS Code requires the selection range to be contained by the range, so the fallback has
  // to be the name range itself rather than a clamp that might not contain it.
  assert.deepEqual(placed?.range, placed?.selectionRange);
});

test("shadowHierarchyItemToCell drops an item no cell owns", () => {
  // Line 6 is between two cells: a marker, or the wrapper's own machinery.
  const mapping = makeMapping();
  assert.equal(
    shadowHierarchyItemToCell(mapping, {
      name: "sample",
      range: range(6, 0, 6, 4),
      selectionRange: range(6, 0, 6, 4),
    }),
    undefined
  );
});

test("shadowHierarchyItemToCell re-homes a result binding to the cell it opens", () => {
  // `val res2_0 = (` is written on the marker line above cell 2, so the binding's name is
  // outside every span - but the statement it binds is the cell's own.
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "res2_0",
    range: range(6, 20, 8, 1),
    selectionRange: range(6, 24, 6, 30),
  });
  assert.equal(placed?.cellUri.fragment, "cell2");
  assert.deepEqual(placed?.selectionRange, range(0, 0, 0, 0));
  assert.deepEqual(placed?.range, range(0, 0, 0, 0));
});

test("shadowHierarchyItemToCell re-homes the trailing result alias too", () => {
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "res1",
    range: range(6, 0, 6, 18),
    selectionRange: range(6, 4, 6, 8),
  });
  assert.equal(placed?.cellUri.fragment, "cell2");
});

test("shadowHierarchyItemToCell leaves a user-written resN inside a cell where it is", () => {
  // The re-homing rule only ever sees names outside a span, so a cell that happens to
  // define `res1` itself takes the ordinary path.
  const mapping = makeMapping();
  const placed = shadowHierarchyItemToCell(mapping, {
    name: "res1",
    range: range(4, 0, 4, 12),
    selectionRange: range(4, 4, 4, 8),
  });
  assert.equal(placed?.cellUri.fragment, "cell1");
  assert.deepEqual(placed?.selectionRange, range(0, 4, 0, 8));
});

test("rangesWithinSpan keeps the ranges a cell can express and drops the rest", () => {
  const span: CellSpan = { cellIndex: 2, cellUri: fakeUri("cell2"), startLine: 7, lineCount: 3 };
  const kept = rangesWithinSpan(span, [range(8, 2, 8, 5), range(10, 0, 10, 3), range(9, 1, 9, 4)]);
  assert.deepEqual(kept, [range(1, 2, 1, 5), range(2, 1, 2, 4)]);
});
