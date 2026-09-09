import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeScalaCliGeneratedSource } from "../src/scalaCliBuild";

test("scala-cli's generated wrapper is recognised", () => {
  assert.ok(
    looksLikeScalaCliGeneratedSource("/repo/fixture/.scala-build/fixture_xxx/src_generated/main/sample.scala")
  );
  assert.ok(looksLikeScalaCliGeneratedSource("C:\\repo\\.scala-build\\x\\src_generated\\main\\sample.scala"));
});

test("the shadow script itself, and unrelated sources, are not wrappers", () => {
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/fixture/notebook-shadow/sample.sc"));
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/fixture/src/Main.scala"));
  // A directory merely *named* like the marker, rather than the build directory itself.
  assert.ok(!looksLikeScalaCliGeneratedSource("/repo/my.scala-build-notes/sample.scala"));
});
