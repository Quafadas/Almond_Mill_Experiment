import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD_TOOLS, isBuildTool, shadowFileExtension } from "../src/buildTool";

test("only the two supported build tools are recognised", () => {
  assert.deepEqual(BUILD_TOOLS, ["mill", "scala-cli"]);
  assert.ok(isBuildTool("mill"));
  assert.ok(isBuildTool("scala-cli"));
  assert.ok(!isBuildTool("sbt"));
  assert.ok(!isBuildTool("scalacli"));
  assert.ok(!isBuildTool(""));
});

test("Mill claims .scala scripts and scala-cli claims .sc", () => {
  assert.equal(shadowFileExtension("mill"), ".scala");
  assert.equal(shadowFileExtension("scala-cli"), ".sc");
});

test("the two tools never produce the same file name, so switching cannot overwrite", () => {
  assert.notEqual(shadowFileExtension("mill"), shadowFileExtension("scala-cli"));
});
