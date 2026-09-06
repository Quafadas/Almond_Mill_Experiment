import assert from "node:assert/strict";
import { test } from "node:test";
import { shadowBaseName } from "../src/shadowNaming";

test("a notebook at the workspace root keeps its own name", () => {
  assert.equal(shadowBaseName("sample.ipynb"), "sample");
});

test("the same path always yields the same name, so reopening overwrites one shadow", () => {
  assert.equal(shadowBaseName("sample.ipynb"), shadowBaseName("sample.ipynb"));
});

test("a nested notebook folds its directories into the name", () => {
  assert.equal(shadowBaseName("analysis/sample.ipynb"), "analysis_sample");
  assert.equal(shadowBaseName("a/b/c/sample.ipynb"), "a_b_c_sample");
});

test("notebooks sharing a basename in different directories get different names", () => {
  assert.notEqual(shadowBaseName("a/sample.ipynb"), shadowBaseName("b/sample.ipynb"));
});

test("characters a Scala identifier can't hold become underscores", () => {
  assert.equal(shadowBaseName("my notebook-v2.ipynb"), "my_notebook_v2");
});

test("runs of separators collapse, and leading and trailing ones are trimmed", () => {
  assert.equal(shadowBaseName("./a  --  b/sample.ipynb"), "a_b_sample");
});

test("a name opening with a digit is prefixed, since Scala identifiers can't", () => {
  assert.equal(shadowBaseName("2024-report.ipynb"), "NB_2024_report");
});

test("a path that sanitizes away entirely falls back to a fixed name", () => {
  assert.equal(shadowBaseName("--.ipynb"), "notebook");
});

test("only the final extension is stripped, not a dotted directory", () => {
  assert.equal(shadowBaseName("v1.2/sample.ipynb"), "v1_2_sample");
});
