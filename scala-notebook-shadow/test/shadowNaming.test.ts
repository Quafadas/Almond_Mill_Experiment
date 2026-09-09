import assert from "node:assert/strict";
import { test } from "node:test";
import { shadowBaseName } from "../src/shadowNaming";

/**
 * The longest name the toolchain accepts, measured on macOS/APFS with scala-cli and Scala
 * 3.7.2: at 241 characters scalac fails to write `<base>$package$.class` and the notebook
 * gets no diagnostics, while the `.sc` itself writes fine up to 252. `shadowBaseName` caps
 * itself below this; the tests check the cap holds, not where the toolchain's own edge is.
 */
const COMPILE_CEILING = 240;

/** Matches the disambiguating suffix `shadowBaseName` appends to an unfaithful name. */
const HASH_SUFFIX = /_[0-9a-f]{12}$/;

test("a notebook at the workspace root keeps its own name", () => {
  assert.equal(shadowBaseName("sample.ipynb"), "sample");
});

test("the same path always yields the same name, so reopening overwrites one shadow", () => {
  assert.equal(shadowBaseName("sample.ipynb"), shadowBaseName("sample.ipynb"));
  assert.equal(shadowBaseName("a b/2024.ipynb"), shadowBaseName("a b/2024.ipynb"));
});

test("a nested notebook folds its directories into the name", () => {
  assert.equal(shadowBaseName("analysis/sample.ipynb"), "analysis_sample");
  assert.equal(shadowBaseName("a/b/c/sample.ipynb"), "a_b_c_sample");
});

test("notebooks sharing a basename in different directories get different names", () => {
  assert.notEqual(shadowBaseName("a/sample.ipynb"), shadowBaseName("b/sample.ipynb"));
});

test("a path Windows spelled with backslashes names the same shadow as the posix one", () => {
  assert.equal(shadowBaseName("a\\b\\sample.ipynb"), "a_b_sample");
  assert.equal(shadowBaseName("a\\b\\sample.ipynb"), shadowBaseName("a/b/sample.ipynb"));
});

test("only the final extension is stripped, not a dotted directory", () => {
  assert.match(shadowBaseName("v1.2/sample.ipynb"), /^v1_2_sample_[0-9a-f]{12}$/);
});

// A name is readable only when it stands for exactly one path. Everything below sanitizes
// lossily, so the name alone can't say which path produced it and carries a hash.

test("characters a Scala identifier can't hold become underscores, plus a hash", () => {
  assert.match(shadowBaseName("my notebook-v2.ipynb"), /^my_notebook_v2_[0-9a-f]{12}$/);
});

test("runs of separators collapse, and leading and trailing ones are trimmed", () => {
  assert.match(shadowBaseName("./a  --  b/sample.ipynb"), /^a_b_sample_[0-9a-f]{12}$/);
});

test("a name opening with a digit is prefixed, since Scala identifiers can't", () => {
  assert.match(shadowBaseName("2024-report.ipynb"), /^NB_2024_report_[0-9a-f]{12}$/);
});

test("a path that sanitizes away entirely falls back to a fixed stem and its hash", () => {
  assert.match(shadowBaseName("--.ipynb"), /^notebook_[0-9a-f]{12}$/);
  assert.notEqual(shadowBaseName("--.ipynb"), shadowBaseName("++.ipynb"));
});

test("paths that sanitize to the same characters still get different names", () => {
  // All three reduce to `a_b_x`: the separator, the hyphen and the underscore in a segment
  // are indistinguishable once sanitized.
  const names = ["a_b/x.ipynb", "a-b/x.ipynb", "a/b_x.ipynb"].map(shadowBaseName);
  assert.equal(new Set(names).size, 3, `expected three distinct names, got ${names.join(", ")}`);
  for (const name of names) {
    assert.match(name, /^a_b_x_[0-9a-f]{12}$/);
  }
});

test("notebooks under non-ASCII directories don't collide on their basename", () => {
  // The directories sanitize away completely, leaving both notebooks named `sample`.
  assert.notEqual(shadowBaseName("分析/sample.ipynb"), shadowBaseName("研究/sample.ipynb"));
  assert.match(shadowBaseName("分析/sample.ipynb"), /^sample_[0-9a-f]{12}$/);
});

test("a directory that differs only in case is a different notebook", () => {
  assert.notEqual(shadowBaseName("a-b/x.ipynb"), shadowBaseName("A-B/x.ipynb"));
});

// Length. The name is the notebook's whole path, so depth and long directory names both
// spend the same budget.

test("a name too long to compile is capped, well under the toolchain's ceiling", () => {
  const deep = `${Array.from({ length: 18 }, (_, i) => `subdirectory${i}`).join("/")}/notebook.ipynb`;
  const name = shadowBaseName(deep);

  assert.ok(name.length > 0);
  assert.equal(name.length, 200);
  assert.ok(name.length <= COMPILE_CEILING, `${name.length} exceeds the compile ceiling`);
});

test("a faithful name is capped too, since the toolchain doesn't care that it's readable", () => {
  const name = shadowBaseName(`${"a".repeat(300)}.ipynb`);

  assert.equal(name.length, 200);
  assert.match(name, HASH_SUFFIX);
});

test("two long paths sharing a truncated prefix still get different names", () => {
  const prefix = Array.from({ length: 18 }, (_, i) => `subdirectory${i}`).join("/");
  const first = shadowBaseName(`${prefix}/alpha.ipynb`);
  const second = shadowBaseName(`${prefix}/beta.ipynb`);

  // The readable halves are identical - only the hash, taken over the full path, differs.
  assert.equal(first.length, 200);
  assert.equal(first.slice(0, -12), second.slice(0, -12));
  assert.notEqual(first, second);
});

test("truncation never leaves an empty segment beside the hash", () => {
  // Cut the readable part mid-way through a run of characters that collapsed to one
  // underscore, so the naive truncation would end in `__<hash>`.
  for (let length = 180; length <= 200; length++) {
    const name = shadowBaseName(`${"a".repeat(length)} - b/x.ipynb`);
    assert.doesNotMatch(name, /__/, `${name} has an empty segment`);
    assert.ok(name.length <= 200);
  }
});

test("a capped name is still a legal Scala identifier", () => {
  const names = [
    shadowBaseName(`${"9".repeat(300)}.ipynb`),
    shadowBaseName(`${"a".repeat(300)}/${"b".repeat(300)}.ipynb`),
    shadowBaseName("--.ipynb"),
  ];
  for (const name of names) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  }
});
