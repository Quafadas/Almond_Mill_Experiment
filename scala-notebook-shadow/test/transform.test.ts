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

test("header carries no dep directive when none are configured, one when there is", () => {
  const cells = [cell(0, "1 + 1\n")];
  const withoutDeps = transform(cells, baseConfig);
  assert.ok(withoutDeps.text.startsWith("//> using scala 3.7.2\n"));
  assert.ok(!withoutDeps.text.includes("//> using dep"));

  const withDeps = transform(cells, { ...baseConfig, mvnDeps: ["com.lihaoyi::upickle:4.0.2"] });
  assert.ok(withDeps.text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n"));
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
  assert.ok(text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n"));
  assert.ok(text.includes("/* [shadow] import $ivy.`com.lihaoyi::upickle:4.0.2` */"));

  const span = mapping.spans[0];
  const lines = text.split("\n");
  assert.match(lines[span.startLine], /^\/\* \[shadow\] import \$ivy/);
  assert.equal(lines[span.startLine + 1], "val j = upickle.default.write(1)");
});

test("$ivy deps are deduplicated against configured mvnDeps and across cells", () => {
  const cells = [
    cell(0, "import $ivy.`com.lihaoyi::upickle:4.0.2`\n"),
    cell(1, "import $ivy.`com.lihaoyi::upickle:4.0.2`\n"),
  ];
  const { text } = transform(cells, { ...baseConfig, mvnDeps: ["com.lihaoyi::upickle:4.0.2"] });
  const occurrences = text.split("//> using dep com.lihaoyi::upickle:4.0.2").length - 1;
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

  assert.equal(lines[span0.startLine - 1], `/* --- cell 0 ${cells[0].uri.fragment} */`);
  assert.equal(lines[span0.startLine], "def add(a: Int, b: Int): Int = a + b");

  assert.equal(lines[span1.startLine], "val total = add(1, 2)");
  assert.equal(lines[span1.startLine + 1], 'val label = s"total is $total"');
  // The next cell's marker must land immediately after, even though cell 1 had no trailing newline.
  assert.equal(lines[span1.startLine + span1.lineCount], `/* --- cell 2 ${cells[2].uri.fragment} */`);
});

test("cell text is inserted verbatim with no indentation or trimming", () => {
  const cells = [cell(0, "  val x = 1\n\tval y = 2  \n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[0];
  assert.equal(lines[span.startLine], "  val x = 1");
  assert.equal(lines[span.startLine + 1], "\tval y = 2  ");
});

// --- Almond-style cell handling: wrapping ------------------------------------

test("cells are wrapped in a single object so top-level statements are legal Scala", () => {
  const cells = [cell(0, 'println("hi")\n'), cell(1, "val n = 2\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");

  const openIndex = lines.findIndex((l) => l.startsWith("object "));
  assert.ok(openIndex >= 0, "wrapper object is emitted");
  assert.equal(lines[openIndex], "object NotebookCells {");
  // Every cell marker and body line sits after the opening and before the close.
  assert.ok(mapping.spans.every((s) => s.startLine > openIndex));
  assert.equal(lines[lines.length - 2], "}", "wrapper is closed on the final line");
  assert.equal(lines[lines.length - 1], "", "text ends with a trailing newline");

  // The statement itself is untouched, at its own line.
  assert.ok(lines[mapping.spans[0].startLine].startsWith('println("hi")'));
});

test("wrapper object name comes from config, falling back for invalid or keyword names", () => {
  const cells = [cell(0, "val n = 2\n")];
  const named = transform(cells, { ...baseConfig, wrapperObjectName: "sample_2" });
  assert.ok(named.text.includes("object sample_2 {"));

  for (const bad of ["", "2sample", "my-notebook", "object", "given"]) {
    const fallback = transform(cells, { ...baseConfig, wrapperObjectName: bad });
    assert.ok(fallback.text.includes("object NotebookCells {"), `"${bad}" falls back to the default name`);
  }
});

test("a bare trailing expression cell is emitted verbatim, with its warning suppressed by header", () => {
  // Almond binds a cell's trailing expression to `resN`; inside our wrapper it is a
  // discarded statement, so scalac would warn on idiomatic notebook cells without this.
  const cells = [cell(0, "val n = 2\n"), cell(1, "n + 1\n")];
  const { text, mapping } = transform(cells, baseConfig);
  assert.ok(
    text.includes('//> using option "-Wconf:msg=A pure expression does nothing in statement position:s"\n')
  );
  assert.ok(text.split("\n")[mapping.spans[1].startLine].startsWith("n + 1"));
});

test("preamble sits inside the wrapper, before the first cell, and is counted in headerLines", () => {
  const preamble = ["import almond.api.JupyterAPIHolder.value._", 'val predefN = 2'];
  const cells = [cell(0, "val m = 2 * predefN\n")];
  const { text, mapping } = transform(cells, { ...baseConfig, preamble });
  const lines = text.split("\n");

  const openIndex = lines.indexOf("object NotebookCells {");
  assert.deepEqual(lines.slice(openIndex + 1, openIndex + 1 + preamble.length), preamble);
  assert.equal(mapping.headerLines, openIndex + 1 + preamble.length);
  assert.equal(lines[mapping.headerLines], `/* --- cell 0 ${cells[0].uri.fragment} */`);
  assert.equal(mapping.spans[0].startLine, mapping.headerLines + 1);
});

test("almondVersion adds the kernel API dependency, JitPack and the predef imports", () => {
  const cells = [cell(0, 'Markdown("# Hello World")\n')];
  const { text, mapping } = transform(cells, { ...baseConfig, almondVersion: "0.14.5" });
  const lines = text.split("\n");

  assert.ok(text.includes("//> using repository https://jitpack.io\n"));
  assert.ok(text.includes("//> using dep sh.almond::jupyter-api:0.14.5\n"));

  const openIndex = lines.indexOf("object NotebookCells {");
  const prelude = lines.slice(openIndex + 1, mapping.headerLines);
  assert.ok(prelude.some((line) => line.includes("import almond.display.{") && line.includes("Markdown")));
  assert.ok(prelude.includes("val kernel: almond.api.JupyterApi = ???"));
  assert.ok(prelude.includes("import kernel.{publish, commHandler}"));
  // Everything the prelude emits is header, so the cell still maps to its own lines.
  assert.ok(lines[mapping.headerLines].startsWith(`/* --- cell 0 ${cells[0].uri.fragment} */`));
  assert.equal(lines[mapping.spans[0].startLine], 'Markdown("# Hello World"))');
});

test("ammoniteVersion adds the Ammonite API dependency and the repl/interp bridges", () => {
  const cells = [cell(0, "repl.sess.save()\n")];
  const { text, mapping } = transform(cells, { ...baseConfig, ammoniteVersion: "3.0.8" });
  const lines = text.split("\n");

  assert.ok(text.includes("//> using dep com.lihaoyi:ammonite-repl-api_3.3.7:3.0.8\n"));
  // No JitPack: only the Almond half needs it.
  assert.ok(!text.includes("//> using repository"));

  const openIndex = lines.indexOf("object NotebookCells {");
  const preludeLines = lines.slice(openIndex + 1, mapping.headerLines);
  assert.deepEqual(preludeLines, [
    "import _root_.ammonite.interp.api.InterpBridge.{value => interp}",
    "import _root_.ammonite.repl.ReplBridge.{value => repl}",
    "import _root_.ammonite.repl.ReplBridge.value.{codeColorsImplicit, tprintColorsImplicit, show}",
  ]);
});

test("the prelude is left out when unset, and the configured preamble follows it", () => {
  const cells = [cell(0, "val x = 1\n")];
  const off = transform(cells, { ...baseConfig, preamble: ["val predefN = 2"] });
  assert.ok(!off.text.includes("sh.almond"));
  assert.ok(!off.text.includes("ammonite"));
  assert.ok(!off.text.includes("jitpack"));

  const on = transform(cells, {
    ...baseConfig,
    almondVersion: "0.14.5",
    ammoniteVersion: "3.0.8",
    preamble: ["val predefN = 2"],
  });
  const lines = on.text.split("\n");
  // Ammonite first, then Almond, then the configured preamble last.
  const openIndex = lines.indexOf("object NotebookCells {");
  assert.ok(lines[openIndex + 1].includes("InterpBridge"));
  assert.equal(lines[on.mapping.headerLines - 1], "val predefN = 2");
  assert.ok(on.text.indexOf("ammonite-repl-api") < on.text.indexOf("sh.almond::jupyter-api"));
});

test("a cell redefining a prelude name is nested rather than duplicating it", () => {
  const cells = [cell(0, "val kernel = 1\n")];
  const { text } = transform(cells, { ...baseConfig, almondVersion: "0.14.5" });
  assert.ok(text.includes("object `shadow scope 1` {"));
});

test("wrapping preserves exact cell line mapping across a multi-statement cell", () => {
  const cells = [
    cell(0, "def add(a: Int, b: Int): Int = a + b\n"),
    cell(1, 'println("hi")\nimport scala.collection.mutable\nval buf = mutable.ListBuffer(add(1, 2))\n'),
  ];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[1];

  assert.equal(span.lineCount, 3);
  assert.ok(lines[span.startLine].startsWith('println("hi")'));
  assert.equal(lines[span.startLine + 1], "import scala.collection.mutable");
  assert.equal(lines[span.startLine + 2], "val buf = mutable.ListBuffer(add(1, 2))");
});

// --- Almond-style cell handling: magic imports -------------------------------

test("$dep is translated like $ivy", () => {
  const { text } = transform([cell(0, "import $dep.`com.lihaoyi::upickle:4.0.2`\n")], baseConfig);
  assert.ok(text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n"));
  assert.ok(text.includes("/* [shadow] import $dep.`com.lihaoyi::upickle:4.0.2` */"));
});

test("several coordinates on one import line are all collected", () => {
  const { text } = transform(
    [cell(0, "import $ivy.`com.lihaoyi::upickle:4.0.2`, $ivy.`com.lihaoyi::os-lib:0.11.3`\n")],
    baseConfig
  );
  assert.ok(text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n//> using dep com.lihaoyi::os-lib:0.11.3\n"));
});

test("the braced import group form is collected", () => {
  const { text } = transform(
    [cell(0, "import $ivy.{`com.lihaoyi::upickle:4.0.2`, `com.lihaoyi::os-lib:0.11.3`}\n")],
    baseConfig
  );
  assert.ok(text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n//> using dep com.lihaoyi::os-lib:0.11.3\n"));
});

test("$repo becomes a repositories header, emitted before mvnDeps", () => {
  const cells = [cell(0, "import $repo.`https://jitpack.io`\nimport $ivy.`com.lihaoyi::os-lib:0.11.3`\n")];
  const { text } = transform(cells, baseConfig);
  assert.ok(text.includes("//> using repository https://jitpack.io\n"));
  assert.ok(text.indexOf("//> using repository") < text.indexOf("//> using dep"));
  assert.ok(text.includes("/* [shadow] import $repo.`https://jitpack.io` */"));
});

test("magic imports with no header equivalent are neutralized without adding deps", () => {
  const cells = [
    cell(0, "import $file.helpers\n"),
    cell(1, "import $scalac.`-Xfatal-warnings`\n"),
    cell(2, "import $profile.`foo`\n"),
    cell(3, "import $plugin.$ivy.`org.typelevel:::kind-projector:0.13.3`\n"),
  ];
  const { text } = transform(cells, baseConfig);
  assert.ok(!text.includes("mvnDeps"), "none of these contribute a dependency");
  assert.ok(!text.includes("repositories"));
  for (const line of ["import $file.helpers", "import $scalac.`-Xfatal-warnings`", "import $profile.`foo`"]) {
    assert.ok(text.includes(`/* [shadow] ${line} */`), `${line} is commented out`);
  }
  assert.ok(text.includes("/* [shadow] import $plugin.$ivy.`org.typelevel:::kind-projector:0.13.3` */"));
});

test("a coordinate using Almond's `_` version placeholder is dropped, not written to the header", () => {
  // Almond resolves `_` against its own build; scala-cli cannot, and an unresolvable
  // header dependency would fail the whole compile and bury every real diagnostic.
  const cells = [cell(0, "import $ivy.`sh.almond::scala-kernel-api:_`\nimport $ivy.`com.lihaoyi::os-lib:0.11.3`\n")];
  const { text } = transform(cells, baseConfig);
  assert.ok(!text.includes("//> using dep sh.almond::scala-kernel-api:_"), "not written into the header");
  assert.ok(text.includes("//> using dep com.lihaoyi::os-lib:0.11.3\n"), "the resolvable dep survives");
  assert.ok(text.includes("/* [shadow] import $ivy.`sh.almond::scala-kernel-api:_` */"));
});

test("an ordinary Scala import is left completely alone", () => {
  const cells = [cell(0, "import scala.collection.mutable\nimport java.nio.file.{Files, Paths}\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[0];
  assert.equal(lines[span.startLine], "import scala.collection.mutable");
  assert.equal(lines[span.startLine + 1], "import java.nio.file.{Files, Paths}");
  assert.ok(!text.includes("[shadow]"));
});

// --- Almond-style cell handling: resN_M result bindings ----------------------

/** Every cell line must still begin with its original text, so columns never move. */
function assertColumnsPreserved(cells: SourceCell[], text: string, mapping: { spans: { startLine: number }[] }) {
  const lines = text.split("\n");
  const codeCells = cells.filter((c) => c.isCode && c.languageId === "scala");
  mapping.spans.forEach((span, i) => {
    const source = codeCells[i].text.replace(/\n$/, "").split("\n");
    source.forEach((original, offset) => {
      const emitted = lines[span.startLine + offset];
      if (emitted.startsWith("/* [shadow] ")) {
        // A magic import, commented out by design. The prefix is the same width as the
        // `// [shadow] ` one it replaces, so its column shift is unchanged.
        assert.ok(emitted.startsWith(`/* [shadow] ${original}`));
        return;
      }
      assert.ok(
        emitted.startsWith(original),
        `line ${offset} of cell ${i} must keep its prefix: ${JSON.stringify(emitted)}`
      );
    });
  });
}

test("a cell's trailing expression is bound exactly as Almond numbers it", () => {
  // Reproduces the reported session: os.pwd is statement 2 of the first cell -> res1_2.
  const cells = [
    cell(0, "import $ivy.`com.lihaoyi::os-lib:0.11.3`\n\ndef add(a: Int, b: Int): Int = a + b\nos.pwd\n"),
    cell(1, "println(res1_2)\n"),
  ];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[0];

  assert.ok(lines[span.startLine + 2].endsWith("; val res1_2 = ("), "opener appended to the preceding line");
  assert.equal(lines[span.startLine + 3], "os.pwd)", "closer appended to the expression's line");
  assertColumnsPreserved(cells, text, mapping);
});

test("bindings are appends only: line count and column positions are untouched", () => {
  const cells = [cell(0, 'val a = 1\nprintln("hi")\nval b = 2\nb + a\n')];
  const { text, mapping } = transform(cells, baseConfig);
  assert.equal(mapping.spans[0].lineCount, 4, "no line is inserted into the cell");
  assertColumnsPreserved(cells, text, mapping);
});

test("definitions and imports get no binding, matching Almond", () => {
  const cells = [cell(0, "val a = 1\nimport scala.collection.mutable\ndef f = 1\n")];
  const { text } = transform(cells, baseConfig);
  assert.ok(!text.includes("res1_"), "nothing in this cell is an expression");
});

test("cell numbering follows document position among Scala code cells", () => {
  const cells: SourceCell[] = [
    cell(0, "1 + 1\n"),
    cell(1, "# markdown", { isCode: false, languageId: "markdown" }),
    cell(2, "2 + 2\n"),
  ];
  const { text } = transform(cells, baseConfig);
  assert.ok(text.includes("val res1_0 = ("), "first code cell is 1");
  assert.ok(text.includes("val res2_0 = ("), "the markdown cell does not consume a number");
});

test("a single-statement cell binds both resN and resN_0", () => {
  // Ammonite drops the suffix for a lone statement; binding both spellings costs an
  // unused val and saves guessing which one the user saw in their kernel output.
  const { text } = transform([cell(0, "1 + 1\n")], baseConfig);
  assert.ok(text.includes("val res1_0 = ("));
  assert.ok(text.includes("val res1 = res1_0"));

  const multi = transform([cell(0, "val a = 1\n1 + 1\n")], baseConfig);
  assert.ok(multi.text.includes("val res1_1 = ("));
  assert.ok(!multi.text.includes("val res1 = "), "no bare resN when the cell holds several statements");
});

test("alias lines land outside the cell span, so they shift no cell line", () => {
  const cells = [cell(0, "1 + 1\n"), cell(1, "val after = 2\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const [first, second] = mapping.spans;

  assert.equal(first.lineCount, 1);
  assert.equal(lines[second.startLine], "val after = 2");
  assert.ok(lines.slice(first.startLine + first.lineCount, second.startLine).includes("val res1 = res1_0"));
});

test("an opener spans a comment sitting above the expression", () => {
  const cells = [cell(0, '// a note\nprintln("hi")\n')];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  // The comment line can't be appended to, so the opener moves up onto the cell marker.
  assert.ok(lines[mapping.spans[0].startLine - 1].endsWith("val res1_0 = ("));
  assert.equal(lines[mapping.spans[0].startLine], "// a note");
  assert.equal(lines[mapping.spans[0].startLine + 1], 'println("hi"))');
});

test("no binding is emitted when appending would land inside a comment", () => {
  // A trailing line comment would swallow the closing paren and unbalance the file.
  const { text } = transform([cell(0, "val a = 1\na + 1 // the answer\n")], baseConfig);
  assert.ok(!text.includes("res1_"), "skipped rather than emitting an unbalanced paren");
});

test("a cell that cannot be segmented is emitted verbatim with no bindings", () => {
  const cells = [cell(0, "val xs = List(\n  1,\n")]; // brackets never close
  const { text, mapping } = transform(cells, baseConfig);
  assert.ok(!text.includes("res1_"));
  assertColumnsPreserved(cells, text, mapping);
});

test("a magic import line is still appendable, so a following expression binds", () => {
  const cells = [cell(0, "import $ivy.`com.lihaoyi::os-lib:0.11.3`\nos.pwd\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  // The block-comment form is what makes this possible; a `//` comment would not be.
  assert.ok(lines[mapping.spans[0].startLine].endsWith("*/ val res1_1 = ("));
  assert.equal(lines[mapping.spans[0].startLine + 1], "os.pwd)");
});

// --- Almond-style cell handling: redefinition across cells -------------------

/** The scope objects opened for redefining cells, in emission order. */
function scopeOpenings(text: string): number[] {
  return text
    .split("\n")
    .map((line, index) => (/^object `shadow scope \d+` \{$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
}

function assertBracesBalance(text: string) {
  const lines = text.split("\n");
  const opened = lines.filter((l) => /\{$/.test(l) && !l.startsWith("//>")).length;
  const closed = lines.filter((l) => l === "}").length;
  assert.equal(closed, opened, "every object opened is closed on its own line");
}

test("cells that define distinct names all share one scope", () => {
  const cells = [cell(0, "val a = 1\n"), cell(1, "val b = 2\n"), cell(2, "def c = 3\n")];
  const { text } = transform(cells, baseConfig);
  assert.deepEqual(scopeOpenings(text), [], "nothing is redefined, so the file stays flat");
});

test("a cell redefining an earlier name is nested one object deeper", () => {
  // Almond would shadow the earlier `total`; in one flat object this is a duplicate member.
  const cells = [cell(0, "val total = 1\n"), cell(1, "val other = 2\n"), cell(2, "val total = 3\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const [opening] = scopeOpenings(text);

  assert.equal(scopeOpenings(text).length, 1, "exactly one scope is opened");
  assert.ok(opening > mapping.spans[1].startLine, "opened after the cell before it");
  assert.equal(lines[opening + 1], `/* --- cell 2 ${cells[2].uri.fragment} */`, "immediately before the marker");
  assert.equal(mapping.spans[2].startLine, opening + 2);
  assert.equal(lines[mapping.spans[2].startLine], "val total = 3");
  assertBracesBalance(text);
  assertColumnsPreserved(cells, text, mapping);
});

test("every later cell stays inside the nested scope, so it sees the new definition", () => {
  const cells = [cell(0, "val total = 1\n"), cell(1, "val total = 2\n"), cell(2, "val doubled = total * 2\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const [opening] = scopeOpenings(text);
  assert.ok(mapping.spans[2].startLine > opening, "the following cell is emitted inside the new scope");
  assertBracesBalance(text);
});

test("each further redefinition adds exactly one more level", () => {
  const cells = [cell(0, "val x = 1\n"), cell(1, "val x = 2\n"), cell(2, "val x = 3\n"), cell(3, "val y = 4\n")];
  const { text } = transform(cells, baseConfig);
  assert.equal(scopeOpenings(text).length, 2, "one per redefining cell, none for the cell that adds a name");
  assert.ok(text.includes("object `shadow scope 1` {"));
  assert.ok(text.includes("object `shadow scope 2` {"));
  assertBracesBalance(text);
});

test("redefining a name from an outer scope, not the innermost one, needs no new scope", () => {
  // Cell 1 opened a scope; cell 2's `a` shadows cell 0's lexically, with nothing to collide with.
  const cells = [cell(0, "val a = 1\nval b = 2\n"), cell(1, "val b = 3\n"), cell(2, "val a = 4\n")];
  const { text } = transform(cells, baseConfig);
  assert.equal(scopeOpenings(text).length, 1);
});

test("a companion pair written in one cell is not a self-collision", () => {
  const cells = [cell(0, "case class Point(x: Int)\nobject Point { val origin = Point(0) }\n")];
  const { text } = transform(cells, baseConfig);
  assert.deepEqual(scopeOpenings(text), [], "a class and its companion belong in the same scope");
});

test("a definition we cannot name opens a scope, but only once something could collide", () => {
  const first = transform([cell(0, "extension (i: Int) def twice: Int = i * 2\n")], baseConfig);
  assert.deepEqual(scopeOpenings(first.text), [], "nothing is in scope yet for it to shadow");

  const later = transform(
    [cell(0, "val a = 1\n"), cell(1, "extension (i: Int) def twice: Int = i * 2\n")],
    baseConfig
  );
  assert.equal(scopeOpenings(later.text).length, 1, "we cannot rule out a collision, so we nest");
});

test("nesting is capped, degrading to a duplicate definition rather than overflowing scalac", () => {
  const cells = Array.from({ length: 140 }, (_, i) => cell(i, "val x = 1\n"));
  const { text, mapping } = transform(cells, baseConfig);
  assert.equal(scopeOpenings(text).length, 100, "stops at the cap");
  assert.equal(mapping.spans.length, 140, "every cell is still emitted and mapped");
  assertBracesBalance(text);
});

test("result bindings and markers are unaffected by a scope opening", () => {
  const cells = [cell(0, "val v = 1\n"), cell(1, "val v = 2\nv + 1\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");
  const span = mapping.spans[1];
  assert.equal(lines[span.startLine], "val v = 2 ; val res2_1 = (");
  assert.equal(lines[span.startLine + 1], "v + 1)");
  assertColumnsPreserved(cells, text, mapping);
});

/**
 * The `//> using` header. Everything below it - the wrapper object, the prelude, cell
 * markers, bindings, nesting - is covered by the tests above; these pin the directive
 * spellings, which scala-cli is strict about and which no other test would notice breaking.
 */
test("the header opens with the configured Scala version", () => {
  const { text } = transform([cell(0, "1 + 1\n")], baseConfig);
  assert.ok(text.startsWith("//> using scala 3.7.2\n"));
});

test("each dependency and repository gets its own directive, with no grouping key", () => {
  const cells = [cell(0, "1 + 1\n")];
  const { text } = transform(cells, {
    ...baseConfig,
    almondVersion: "0.14.5",
    mvnDeps: ["com.lihaoyi::upickle:4.0.2", "com.lihaoyi::os-lib:0.11.3"],
  });

  assert.ok(text.includes("//> using repository https://jitpack.io\n"));
  assert.ok(text.includes("//> using dep sh.almond::jupyter-api:0.14.5\n"));
  assert.ok(text.includes("//> using dep com.lihaoyi::upickle:4.0.2\n"));
  assert.ok(text.includes("//> using dep com.lihaoyi::os-lib:0.11.3\n"));
  assert.ok(!text.includes("mvnDeps"), "a directive is one line; there is no list to group under a key");
  assert.ok(!text.includes("repositories:"));
});

test("the -Wconf options are quoted, whose values contain spaces", () => {
  // A directive value is a whitespace-separated token: unquoted, scala-cli reads
  // `-Wconf:msg=A` and rejects `pure`, `expression`, ... as unknown directive values.
  const cells = [cell(0, "val n = 2\n"), cell(1, "n + 1\n")];
  const { text } = transform(cells, baseConfig);

  assert.ok(
    text.includes('//> using option "-Wconf:msg=A pure expression does nothing in statement position:s"\n')
  );
  assert.ok(text.includes('//> using option "-Wconf:msg=Line is indented too far to the left:s"\n'));
});

test("each -Wconf gets its own option directive", () => {
  // scala-cli takes one value per `using option`; two suppressions under one directive
  // would make the second an unknown value rather than a second flag.
  const cells = [cell(0, "1 + 1\n")];
  const { text } = transform(cells, baseConfig);
  const options = text.split("\n").filter((line) => line.startsWith("//> using option "));

  assert.equal(options.length, 2);
  for (const option of options) {
    assert.match(option, /^\/\/> using option "[^"]*"$/, `one quoted value in ${option}`);
  }
});

test("an indented first line in a cell does not warn later cells to the left", () => {
  // Scala 3 takes a brace region's indent width from its first body line, and warns on
  // every later line left of it. Cells are copied verbatim, so a cell that opens indented
  // sets a width the cells after it fall under - suppressed in the header, since
  // re-indenting would move columns the mapping treats as identical.
  const cells = [cell(0, "  val indented = 1\n"), cell(1, "val flush = 2\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");

  assert.equal(lines[mapping.spans[0].startLine], "  val indented = 1");
  assert.equal(lines[mapping.spans[1].startLine], "val flush = 2");
  assert.ok(text.includes('//> using option "-Wconf:msg=Line is indented too far to the left:s"\n'));
});

test("directive order puts the Scala version first and the option last", () => {
  const cells = [cell(0, "1 + 1\n")];
  const { text } = transform(cells, { ...baseConfig, almondVersion: "0.14.5" });
  const directives = text.split("\n").filter((line) => line.startsWith("//>"));

  assert.ok(directives[0].startsWith("//> using scala "));
  assert.ok(directives[directives.length - 1].startsWith("//> using option "));
  assert.ok(
    directives.findIndex((d) => d.startsWith("//> using repository ")) <
      directives.findIndex((d) => d.startsWith("//> using dep ")),
    "repositories are declared before the deps that need them"
  );
});

test("$ivy coordinates from cells become deps, deduplicated", () => {
  const cells = [
    cell(0, "import $ivy.`com.lihaoyi::upickle:4.0.2`\n"),
    cell(1, "import $ivy.`com.lihaoyi::upickle:4.0.2`\nval x = 1\n"),
  ];
  const { text } = transform(cells, baseConfig);

  assert.equal(text.split("//> using dep com.lihaoyi::upickle:4.0.2").length - 1, 1);
});

test("headerLines counts the directives, so cells still map to their own lines", () => {
  const cells = [cell(0, "val x = 1\n")];
  const { text, mapping } = transform(cells, baseConfig);
  const lines = text.split("\n");

  assert.equal(lines[mapping.headerLines], `/* --- cell 0 ${cells[0].uri.fragment} */`);
  assert.ok(lines[mapping.spans[0].startLine].startsWith("val x = 1"));
});
