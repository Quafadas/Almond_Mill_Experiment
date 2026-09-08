import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { ancestorDirectories, findMillRoot, MILL_ROOT_MARKERS } from "../src/millRoot";

const p = (...segments: string[]) => path.join(path.sep, ...segments);

/** A predicate over a fixed set of existing files, as findMillRoot expects. */
const filesystem = (existing: string[]) => (directory: string, marker: string) =>
  existing.includes(path.join(directory, marker));

test("ancestors run from the start directory up to the stop directory", () => {
  assert.deepEqual(ancestorDirectories(p("ws", "a", "b"), p("ws")), [
    p("ws", "a", "b"),
    p("ws", "a"),
    p("ws"),
  ]);
});

test("a start directory that is the stop directory yields just itself", () => {
  assert.deepEqual(ancestorDirectories(p("ws"), p("ws")), [p("ws")]);
});

test("a start directory outside the stop directory yields nothing, so the walk can't escape", () => {
  assert.deepEqual(ancestorDirectories(p("elsewhere"), p("ws")), []);
  assert.deepEqual(ancestorDirectories(p("ws2"), p("ws")), []);
});

test("the nearest build above the notebook wins, not the workspace root", () => {
  const root = findMillRoot(
    p("ws", "fixture", "sub"),
    p("ws"),
    filesystem([p("ws", "build.mill.yaml"), p("ws", "fixture", "build.mill.yaml")])
  );
  assert.equal(root, p("ws", "fixture"));
});

test("a build in a subdirectory is found from a notebook beside it", () => {
  const root = findMillRoot(p("ws", "fixture"), p("ws"), filesystem([p("ws", "fixture", "build.mill.yaml")]));
  assert.equal(root, p("ws", "fixture"));
});

test("no build anywhere above leaves the caller to fall back", () => {
  assert.equal(findMillRoot(p("ws", "a"), p("ws"), filesystem([])), undefined);
});

test("a build below the notebook is not picked up", () => {
  const root = findMillRoot(p("ws"), p("ws"), filesystem([p("ws", "fixture", "build.mill.yaml")]));
  assert.equal(root, undefined);
});

test("every marker identifies a root on its own", () => {
  for (const marker of MILL_ROOT_MARKERS) {
    assert.equal(
      findMillRoot(p("ws", "a"), p("ws"), filesystem([path.join(p("ws"), marker)])),
      p("ws"),
      `${marker} should mark a Mill root`
    );
  }
});

test("Mill 0.x's build.sc is not a marker, since it can't compile single-file scripts", () => {
  assert.equal(findMillRoot(p("ws", "a"), p("ws"), filesystem([p("ws", "build.sc")])), undefined);
});
