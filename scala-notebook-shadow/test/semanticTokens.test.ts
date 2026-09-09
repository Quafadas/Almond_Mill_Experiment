import assert from "node:assert/strict";
import { test } from "node:test";
import { DecodedToken, decodeTokens, encodeTokens, tokensWithinLines } from "../src/semanticTokens";

/**
 * Tokens are delta-encoded against the token before them, so nothing here can be checked by
 * slicing the array: the point of every test below is that a token's meaning depends on its
 * predecessor, and that dropping a predecessor has to change what is emitted.
 */

function token(line: number, startCharacter: number, length = 3, tokenType = 1, tokenModifiers = 0): DecodedToken {
  return { line, startCharacter, length, tokenType, tokenModifiers };
}

test("decodeTokens resolves line deltas and same-line column deltas", () => {
  // (line 0, col 0), then (line 0, col 5) on the same line, then (line 2, col 4).
  const decoded = decodeTokens([0, 0, 3, 1, 0, 0, 5, 2, 4, 8, 2, 4, 1, 7, 0]);

  assert.deepEqual(decoded, [
    token(0, 0, 3, 1, 0),
    token(0, 5, 2, 4, 8),
    token(2, 4, 1, 7, 0),
  ]);
});

test("decodeTokens drops a trailing partial token rather than inventing its fields", () => {
  assert.deepEqual(decodeTokens([1, 2, 3, 4, 5, 0, 1]), [token(1, 2, 3, 4, 5)]);
  assert.deepEqual(decodeTokens([]), []);
});

test("encodeTokens is the inverse of decodeTokens", () => {
  const data = [2, 4, 3, 1, 0, 0, 6, 2, 5, 1, 3, 1, 4, 2, 0];
  assert.deepEqual([...encodeTokens(decodeTokens(data))], data);
});

test("encodeTokens orders tokens, so a delta can never come out negative", () => {
  const data = encodeTokens([token(4, 2), token(1, 9), token(1, 3)]);
  assert.deepEqual([...decodeTokens(data)].map((t) => [t.line, t.startCharacter]), [
    [1, 3],
    [1, 9],
    [4, 2],
  ]);
  // First token absolute, then a same-line column delta, then a line delta.
  assert.deepEqual([data[0], data[1], data[5], data[6], data[10], data[11]], [1, 3, 0, 6, 3, 2]);
});

test("tokensWithinLines keeps only the requested lines and rebases them to zero", () => {
  const shadow = encodeTokens([token(3, 0), token(7, 2), token(8, 4), token(12, 1)]);
  const kept = decodeTokens(tokensWithinLines(shadow, 7, 9));

  assert.deepEqual(
    kept.map((t) => [t.line, t.startCharacter]),
    [
      [0, 2],
      [1, 4],
    ]
  );
});

test("tokensWithinLines rebuilds the column delta after dropping an earlier token on the line", () => {
  // Two tokens on shadow line 5; the first belongs to a synthesized `resN_M` binding at
  // column 0 and is not in range. The second's delta was relative to it.
  const shadow = encodeTokens([token(5, 0), token(6, 4), token(6, 10)]);
  const kept = tokensWithinLines(shadow, 6, 6);

  // Both survivors are on the one line: an absolute start, then a delta from it.
  assert.deepEqual([...kept], [0, 4, 3, 1, 0, 0, 6, 3, 1, 0]);
  assert.deepEqual(
    decodeTokens(kept).map((t) => [t.line, t.startCharacter]),
    [
      [0, 4],
      [0, 10],
    ]
  );
});

test("tokensWithinLines carries the token type and modifiers through untouched", () => {
  const shadow = encodeTokens([token(4, 1, 6, 9, 3)]);
  assert.deepEqual(decodeTokens(tokensWithinLines(shadow, 4, 4)), [token(0, 1, 6, 9, 3)]);
});

test("tokensWithinLines returns nothing when the cell holds no tokens", () => {
  const shadow = encodeTokens([token(1, 0), token(20, 0)]);
  assert.equal(tokensWithinLines(shadow, 5, 9).length, 0);
  assert.equal(tokensWithinLines([], 0, 3).length, 0);
});
