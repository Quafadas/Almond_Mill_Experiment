/**
 * Pure semantic-token surgery: keep the tokens Metals reported for one cell's lines of a
 * shadow script, and renumber them into that cell's own coordinates.
 *
 * Semantic tokens do not arrive as a list of positions. They arrive as a flat array of
 * 5-tuples, each one *relative to the token before it*:
 *
 *   deltaLine, deltaStartCharacter, length, tokenType, tokenModifiers
 *
 * `deltaLine` counts lines since the previous token; `deltaStartCharacter` counts columns
 * since the previous token when both sit on the same line, and is absolute otherwise. So a
 * slice of the array is meaningless on its own - dropping the tokens before a cell changes
 * what every later delta means. The whole thing has to be decoded to absolute positions,
 * filtered, rebased and re-encoded, which is what this module does.
 *
 * Free of any VS Code import (the runtime only needs `data`), so it is unit testable with
 * plain `node --test`.
 */

/** Ints per token in the encoded array. */
const TOKEN_STRIDE = 5;

/** One token at an absolute position in the document it was reported for. */
export interface DecodedToken {
  line: number;
  startCharacter: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
}

/**
 * Decode the delta-encoded array into absolute positions.
 *
 * A trailing partial tuple is dropped: it cannot be interpreted, and guessing at the
 * missing fields would colour a token with whatever type happened to be zero.
 */
export function decodeTokens(data: ArrayLike<number>): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let startCharacter = 0;

  for (let index = 0; index + TOKEN_STRIDE <= data.length; index += TOKEN_STRIDE) {
    const deltaLine = data[index];
    const deltaStart = data[index + 1];

    line += deltaLine;
    startCharacter = deltaLine === 0 ? startCharacter + deltaStart : deltaStart;

    tokens.push({
      line,
      startCharacter,
      length: data[index + 2],
      tokenType: data[index + 3],
      tokenModifiers: data[index + 4],
    });
  }

  return tokens;
}

/**
 * Re-encode absolute tokens into the delta form VS Code expects.
 *
 * Sorts first: the encoding cannot express a token that starts before the one in front of
 * it, so an out-of-order input would produce negative deltas and colour arbitrary text.
 * Metals' output is already ordered, which makes the sort free in practice and the function
 * total regardless.
 */
export function encodeTokens(tokens: DecodedToken[]): Uint32Array {
  const ordered = [...tokens].sort((a, b) => a.line - b.line || a.startCharacter - b.startCharacter);
  const data = new Uint32Array(ordered.length * TOKEN_STRIDE);

  let previousLine = 0;
  let previousStart = 0;

  ordered.forEach((token, position) => {
    const offset = position * TOKEN_STRIDE;
    const deltaLine = token.line - previousLine;
    data[offset] = deltaLine;
    data[offset + 1] = deltaLine === 0 ? token.startCharacter - previousStart : token.startCharacter;
    data[offset + 2] = token.length;
    data[offset + 3] = token.tokenType;
    data[offset + 4] = token.tokenModifiers;
    previousLine = token.line;
    previousStart = token.startCharacter;
  });

  return data;
}

/**
 * The tokens on shadow lines `[firstLine, lastLine]`, renumbered so `firstLine` becomes
 * line 0 - i.e. into the coordinates of the cell that occupies those lines.
 *
 * Columns are left alone: a cell's text is copied into the shadow verbatim, with nothing
 * inserted before it on the line, so a column in one is the same column in the other.
 */
export function tokensWithinLines(
  data: ArrayLike<number>,
  firstLine: number,
  lastLine: number
): Uint32Array {
  const kept = decodeTokens(data)
    .filter((token) => token.line >= firstLine && token.line <= lastLine)
    .map((token) => ({ ...token, line: token.line - firstLine }));
  return encodeTokens(kept);
}
