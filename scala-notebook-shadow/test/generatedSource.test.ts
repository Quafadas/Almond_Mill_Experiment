import assert from "node:assert/strict";
import { test } from "node:test";
import {
  looksLikeGeneratedSource,
  looksLikeScalaCliGeneratedSource,
  parseGeneratedSourceHeader,
} from "../src/generatedSource";

const HEADER = [
  "//SOURCECODE_ORIGINAL_FILE_PATH=/repo/fixture/notebook-shadow/sample.scala",
  "//SOURCECODE_ORIGINAL_CODE_START_MARKER",
  "//| scalaVersion: 3.7.2",
  "object sample {",
].join("\n");

test("the original path and line offset are read out of Mill's markers", () => {
  const header = parseGeneratedSourceHeader(HEADER);
  assert.deepEqual(header, {
    originalPath: "/repo/fixture/notebook-shadow/sample.scala",
    lineOffset: 2,
  });
});

test("the offset is derived from the marker, not assumed to be 2", () => {
  const withExtra = [
    "//SOURCECODE_ORIGINAL_FILE_PATH=/repo/a.scala",
    "// something Mill might add later",
    "//SOURCECODE_ORIGINAL_CODE_START_MARKER",
    "//| scalaVersion: 3.7.2",
  ].join("\n");
  assert.equal(parseGeneratedSourceHeader(withExtra)?.lineOffset, 3);
});

test("files without both markers are not generated sources", () => {
  assert.equal(parseGeneratedSourceHeader("//| scalaVersion: 3.7.2\nobject sample {}"), undefined);
  assert.equal(parseGeneratedSourceHeader("//SOURCECODE_ORIGINAL_FILE_PATH=/repo/a.scala\nobject a {}"), undefined);
  assert.equal(parseGeneratedSourceHeader(""), undefined);
});

test("only .dest/ Scala files are worth opening to check", () => {
  assert.ok(looksLikeGeneratedSource("/repo/out/notebook-shadow/sample.scala/allSourceFiles.dest/sample.scala"));
  assert.ok(looksLikeGeneratedSource("/repo/.bsp/out/notebook-shadow/sample.scala/allSourceFiles.dest/sample.scala"));
  assert.ok(!looksLikeGeneratedSource("/repo/notebook-shadow/sample.scala"));
  assert.ok(!looksLikeGeneratedSource("/repo/out/allSourceFiles.dest/notes.txt"));
});

test("scala-cli's generated wrapper is recognised, and is not confused with Mill's", () => {
  const scalaCliCopy = "/repo/fixture/.scala-build/fixture_xxx/src_generated/main/sample.scala";
  assert.ok(looksLikeScalaCliGeneratedSource(scalaCliCopy));
  assert.ok(!looksLikeGeneratedSource(scalaCliCopy), "not a Mill .dest/ copy, so never relayed as one");

  const millCopy = "/repo/out/notebook-shadow/sample.scala/allSourceFiles.dest/sample.scala";
  assert.ok(!looksLikeScalaCliGeneratedSource(millCopy));
});

test("the scala-cli script itself, and unrelated sources, are not generated copies", () => {
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/fixture/notebook-shadow/sample.sc"));
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/fixture/src/Main.scala"));
  // A directory merely *named* like the marker, rather than the build directory itself.
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/my.scala-build-notes/sample.scala"));
});
