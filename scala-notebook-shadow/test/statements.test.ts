import assert from "node:assert/strict";
import { test } from "node:test";
import { definedNames, scanLines, segmentStatements } from "../src/statements";

function segment(source: string) {
  const result = segmentStatements(source.split("\n"));
  assert.ok(result, "expected the cell to segment");
  return result;
}

test("scanner blanks comments but keeps string and backtick contents as code", () => {
  const [comment, str, ident] = scanLines(['val a = 1 // note', 'val b = "x = "', "import $ivy.`org::name:1.0`"]);

  assert.equal(comment.code.trim(), "val a = 1");
  // A string blanked to spaces would leave "val b =", whose trailing "=" reads as a
  // line continuation and silently swallows the next statement.
  assert.ok(str.code.trim().startsWith("val b ="));
  assert.ok(!str.code.trim().endsWith("="));
  assert.ok(!ident.code.trim().endsWith("."), "backticked coordinate must not leave a dangling dot");
  assert.equal(comment.code.length, "val a = 1 // note".length, "columns stay aligned");
});

test("scanner tracks bracket depth and reports appendability", () => {
  const lines = scanLines(["val xs = List(", "  1,", ")", "val s = 1 // trailing", "/* block */"]);
  assert.equal(lines[0].depthAfter, 1);
  assert.equal(lines[2].depthAfter, 0);
  assert.ok(lines[0].appendable);
  assert.ok(!lines[3].appendable, "a line comment swallows anything appended after it");
  assert.ok(lines[4].appendable, "a closed block comment does not");
  assert.ok(lines[4].blank, "a comment-only line carries no code");
});

test("brackets and comments inside strings do not confuse the scanner", () => {
  const lines = scanLines(['val a = "( // not a comment"', "val b = 2"]);
  assert.equal(lines[0].depthAfter, 0);
  assert.ok(lines[0].appendable);
  const segments = segment('val a = "( // not a comment"\nval b = 2');
  assert.equal(segments.length, 2);
});

test("statements are indexed exactly as Almond counts them, imports and defs included", () => {
  // The cell from the Almond session: `os.pwd` is statement 2, hence res1_2.
  const segments = segment("import $ivy.`com.lihaoyi::os-lib:0.11.3`\n\ndef add(a: Int, b: Int): Int = a + b\nos.pwd");
  assert.deepEqual(
    segments.map((s) => [s.index, s.startLine, s.isExpression]),
    [
      [0, 0, false],
      [1, 2, false],
      [2, 3, true],
    ]
  );
});

test("multi-line statements are held together, not split at every line", () => {
  const segments = segment("val xs = List(\n  1,\n  2\n)\nxs\n  .map(_ * 2)\n  .sum");
  assert.equal(segments.length, 2);
  assert.deepEqual([segments[0].startLine, segments[0].endLine], [0, 3]);
  assert.deepEqual([segments[1].startLine, segments[1].endLine], [4, 6]);
  assert.equal(segments[1].isExpression, true);
});

test("a line ending in `=` continues onto the next line", () => {
  const segments = segment("def describe(n: Int): String =\n  if n > 0 then \"pos\" else \"neg\"\ndescribe(1)");
  assert.equal(segments.length, 2);
  assert.equal(segments[0].isExpression, false);
  assert.equal(segments[1].startLine, 2);
});

test("Scala 3 indented blocks stay inside their statement", () => {
  const segments = segment('if x > 0 then\n  println("a")\nelse\n  println("b")\nval done = 1');
  assert.equal(segments.length, 2);
  assert.deepEqual([segments[0].startLine, segments[0].endLine], [0, 3]);
  assert.equal(segments[0].isExpression, true);
  assert.equal(segments[1].isExpression, false);
});

test("definition forms are all recognised as non-expressions", () => {
  for (const source of [
    "val a = 1",
    "var b = 1",
    "def c = 1",
    "lazy val d = 1",
    "case class E(x: Int)",
    "given f: Int = 1",
    "type G = Int",
    "object H",
    "sealed trait I",
    "enum J { case K }",
    "extension (x: Int) def twice = x * 2",
    "@main def l() = ()",
    "import scala.collection.mutable",
    "export a.b",
  ]) {
    assert.equal(segment(source)[0].isExpression, false, source);
  }
});

test("expression forms are recognised", () => {
  for (const source of ['println("hi")', "1 + 1", "xs.map(_ * 2)", "os.pwd", "if a then b else c"]) {
    assert.equal(segment(source)[0].isExpression, true, source);
  }
});

test("segmentation bails rather than guessing when the cell can't be read", () => {
  assert.equal(segmentStatements(["val xs = List(", "  1,"]), undefined, "brackets never close");
  assert.equal(segmentStatements(["  val indented = 1"]), undefined, "first statement isn't at column 0");
  assert.equal(segmentStatements([")", "val a = 1"]), undefined, "closes a bracket it never opened");
});

test("empty and comment-only cells segment to nothing", () => {
  assert.deepEqual(segmentStatements([]), []);
  assert.deepEqual(segmentStatements(["", "  "]), []);
  assert.deepEqual(segmentStatements(["// just a note"]), []);
});

// --- names introduced by a cell's definitions --------------------------------

function names(source: string) {
  const lines = source.split("\n");
  return definedNames(lines, segmentStatements(lines));
}

test("plain definitions are named", () => {
  assert.deepEqual(names("val x = 1"), { names: ["x"], unknown: false });
  assert.deepEqual(names("var y: Int = 1"), { names: ["y"], unknown: false });
  assert.deepEqual(names("def f(a: Int) = a"), { names: ["f"], unknown: false });
  assert.deepEqual(names("type Alias = Int"), { names: ["Alias"], unknown: false });
  assert.deepEqual(names("class C(n: Int)"), { names: ["C"], unknown: false });
  assert.deepEqual(names("trait T"), { names: ["T"], unknown: false });
  assert.deepEqual(names("enum E:\n  case A"), { names: ["E"], unknown: false });
});

test("modifiers, soft keywords and annotations are stripped before the name", () => {
  assert.deepEqual(names("private lazy val x = 1"), { names: ["x"], unknown: false });
  assert.deepEqual(names("case class Point(x: Int)"), { names: ["Point"], unknown: false });
  assert.deepEqual(names("final case object Nothing2"), { names: ["Nothing2"], unknown: false });
  assert.deepEqual(names("private[this] val hidden = 1"), { names: ["hidden"], unknown: false });
  assert.deepEqual(names("@main def run(): Unit = ()"), { names: ["run"], unknown: false });
  assert.deepEqual(names('@deprecated("x", "1.0") def old = 1'), { names: ["old"], unknown: false });
});

test("a cell reports every name it defines, expressions and imports contributing none", () => {
  const result = names('import scala.collection.mutable\nval a = 1\n1 + 1\nobject O { val inner = 2 }');
  assert.deepEqual(result, { names: ["a", "O"], unknown: false });
});

test("a tuple binding names each of its targets", () => {
  assert.deepEqual(names("val (a, b) = (1, 2)"), { names: ["a", "b"], unknown: false });
  assert.deepEqual(names("val (a, _) = (1, 2)"), { names: ["a"], unknown: false });
});

test("definitions whose name we cannot read are reported as unknown", () => {
  // Each of these does introduce a name; guessing it wrong is worse than saying so.
  for (const source of [
    "extension (i: Int) def twice: Int = i * 2",
    "given Ordering[Int] = Ordering.Int",
    "export mod.*",
    "val Some(x) = option",
  ]) {
    assert.deepEqual(names(source), { names: [], unknown: true }, source);
  }
});

test("a named given is read like any other definition", () => {
  assert.deepEqual(names("given intOrd: Ordering[Int] = Ordering.Int"), { names: ["intOrd"], unknown: false });
});

test("a cell that cannot be segmented defines an unknown set of names", () => {
  const lines = ["val xs = List(", "  1,"];
  assert.deepEqual(definedNames(lines, segmentStatements(lines)), { names: [], unknown: true });
});

test("statementNames reads a definition spread over several lines", () => {
  assert.deepEqual(names("def f(\n  a: Int\n) = a"), { names: ["f"], unknown: false });
});
