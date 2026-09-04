import assert from "node:assert/strict";
import { test } from "node:test";
import { ScalaNotebookConfig, SourceCell, transform } from "../src/transform";
import { fakeUri } from "./testUtil";

const baseConfig: ScalaNotebookConfig = {
  scalaVersion: "3.7.2",
  mvnDeps: [],
  preamble: [],
};

function cell(index: number, text: string, opts: Partial<SourceCell> = {}): SourceCell {
  return {
    index,
    isCode: true,
    languageId: "scala",
    text,
    uri: fakeUri(`W${index.toString(16).padStart(8, "0")}`),
    ...opts,
  };
}

test("determinism: same notebook content produces byte-identical shadow text", () => {
  const cells = [cell(0, "def add(a: Int, b: Int): Int = a + b\n"), cell(1, "val x = add(1, 2)\n")];
  const a = transform(cells, baseConfig);
  const b = transform(cells, baseConfig);
  assert.equal(a.text, b.text);
  assert.deepEqual(a.mapping, b.mapping);
});

test("header omits mvnDeps block when empty, includes it when configured", () => {
  const cells = [cell(0, "1 + 1\n")];
  const withoutDeps = transform(cells, baseConfig);
  assert.ok(withoutDeps.text.startsWith("//| scalaVersion: 3.7.2\n"));
  assert.ok(!withoutDeps.text.includes("mvnDeps"));

  const withDeps = transform(cells, { ...baseConfig, mvnDeps: ["com.lihaoyi::upickle:4.0.2"] });
  assert.ok(withDeps.text.includes("//| mvnDeps:\n//| - com.lihaoyi::upickle:4.0.2\n"));
});

test("markdown and non-scala cells are skipped entirely", () => {
  const cells: SourceCell[] = [
    cell(0, "def add(a: Int, b: Int): Int = a + b\n"),
    cell(1, "# a markdown cell", { isCode: false, languageId: "markdown" }),
    cell(2, "print('hi')", { languageId: "python" }),
    cell(3, "val x = add(1, 2)\n"),
  ];
  const { text, mapping } = transform(cells, baseConfig);
  assert.equal(mapping.spans.length, 2);
  assert.deepEqual(
    mapping.spans.map((s) => s.cellIndex),
    [0, 3]
  );
  assert.ok(!text.includes("markdown cell"));
  assert.ok(!text.includes("print("));
});

test("$ivy import lines are rewritten in place and added to mvnDeps, preserving line numbers", () => {
  const cells = [cell(0, 'import $ivy.`com.lihaoyi::upickle:4.0.2`\nval j = upickle.default.write(1)\n')];
  const { text, mapping } = transform(cells, baseConfig);
  assert.ok(text.includes("//| mvnDeps:\n//| - com.lihaoyi::upickle:4.0.2\n"));
  assert.ok(text.includes("// [shadow] import $ivy.`com.lihaoyi::upickle:4.0.2`"));

  const span = mapping.spans[0];
  const lines = text.split("\n");
  assert.match(lines[span.startLine], /^\/\/ \[shadow\] import \$ivy/);
  assert.equal(lines[span.startLine + 1], "val j = upickle.default.write(1)");
});

test("$ivy deps are deduplicated against configured mvnDeps and across cells", () => {
  const cells = [
    cell(0, "import $ivy.`com.lihaoyi::upickle:4.0.2`\n"),
    cell(1, "import $ivy.`com.lihaoyi::upickle:4.0.2`\n"),
  ];
  const { text } = transform(cells, { ...baseConfig, mvnDeps: ["com.lihaoyi::upickle:4.0.2"] });
  const occurrences = text.split("//| - com.lihaoyi::upickle:4.0.2").length - 1;
  assert.equal(occurrences, 1);
});

test("mapping arithmetic: three cells, one lacking a trailing newline, one with an $ivy line", () => {
  const cells = [
    cell(0, "def add(a: Int, b: Int): Int = a + b\n"),
    // no trailing newline, two real lines
    cell(1, "val total = add(1, 2)\nval label = s\"total is $total\""),
    cell(2, 'import $ivy.`com.lihaoyi::upickle:4.0.2`\nval j = 1\n'),
  ];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");

  assert.equal(mapping.spans.length, 3);

  const [span0, span1, span2] = mapping.spans;
  assert.equal(span0.lineCount, 1);
  assert.equal(span1.lineCount, 2, "cell without trailing newline still reports its real line count");
  assert.equal(span2.lineCount, 2);

  // Spans are contiguous and increasing (marker line sits at startLine - 1).
  assert.ok(span1.startLine > span0.startLine + span0.lineCount);
  assert.ok(span2.startLine > span1.startLine + span1.lineCount);

  assert.equal(lines[span0.startLine - 1], "// --- cell 0 " + cells[0].uri.fragment);
  assert.equal(lines[span0.startLine], "def add(a: Int, b: Int): Int = a + b");

  assert.equal(lines[span1.startLine], "val total = add(1, 2)");
  assert.equal(lines[span1.startLine + 1], 'val label = s"total is $total"');
  // The next cell's marker must land immediately after, even though cell 1 had no trailing newline.
  assert.equal(lines[span1.startLine + span1.lineCount], "// --- cell 2 " + cells[2].uri.fragment);
});

test("cell text is inserted verbatim with no indentation or trimming", () => {
  const cells = [cell(0, "  val x = 1\n\tval y = 2  \n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[0];
  assert.equal(lines[span.startLine], "  val x = 1");
  assert.equal(lines[span.startLine + 1], "\tval y = 2  ");
});
