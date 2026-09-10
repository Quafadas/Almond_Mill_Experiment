import assert from "node:assert/strict";
import { test } from "node:test";
import { looksGenerated, orphanedShadowNames } from "../src/shadowCleanup";
import { shadowFileName } from "../src/shadowNaming";

test("a shadow whose notebook is still there is kept", () => {
  assert.deepEqual(orphanedShadowNames(["sample.sc"], ["sample.ipynb"]), []);
  assert.deepEqual(orphanedShadowNames(["analysis_sample.sc"], ["analysis/sample.ipynb"]), []);
});

test("a shadow no notebook maps to is an orphan", () => {
  assert.deepEqual(orphanedShadowNames(["gone.sc", "sample.sc"], ["sample.ipynb"]), ["gone.sc"]);
});

test("a renamed notebook leaves its old shadow behind, and only that one", () => {
  const before = shadowFileName("draft/sample.ipynb");
  const after = shadowFileName("final/sample.ipynb");
  assert.notEqual(before, after);
  assert.deepEqual(orphanedShadowNames([before, after], ["final/sample.ipynb"]), [before]);
});

test("a notebook whose name needed a hash still claims its shadow", () => {
  const name = shadowFileName("a b/2024.ipynb");
  assert.deepEqual(orphanedShadowNames([name], ["a b/2024.ipynb"]), []);
});

test("notebooks with no shadow yet cost nothing", () => {
  assert.deepEqual(orphanedShadowNames([], ["sample.ipynb", "other.ipynb"]), []);
});

test("the directory's other contents are none of the sweep's business", () => {
  const entries = ["project.scala", "sample.scala", ".scalafmt.conf", "README.md"];
  assert.deepEqual(orphanedShadowNames(entries, []), []);
});

test("a generated shadow is recognised by its cell marker", () => {
  const shadow = ["//> using scala 3.7.2", "object sample {", "/* --- cell 0 W1sZmlsZQ== */", "val x = 1", "}"].join("\n");
  assert.equal(looksGenerated(shadow), true);
});

test("a hand-written script in the shadow directory is not taken for a shadow", () => {
  assert.equal(looksGenerated("//> using scala 3.7.2\nprintln(\"hello\")\n"), false);
  assert.equal(looksGenerated(""), false);
});
