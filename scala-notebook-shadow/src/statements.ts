/**
 * Conservative segmentation of a Scala cell into its top-level statements, used to
 * reproduce Almond's `resN_M` result bindings (see `transform`). There is no Scala
 * parser here - only a scanner good enough to know where comments, strings and
 * brackets are - so every function bails out (returning `undefined`) rather than
 * guessing when the shape of the code is unclear. A bail costs us a `resN_M`
 * binding; a wrong guess would emit broken Scala and bury every real diagnostic.
 */

export interface ScannedLine {
  /**
   * The line with comment and string *contents* blanked to spaces. Column positions
   * are preserved, so offsets taken from `code` are valid in the original line.
   */
  code: string;
  /** Bracket nesting depth entering this line. */
  depthBefore: number;
  /** Bracket nesting depth leaving this line. */
  depthAfter: number;
  /** Whether code appended to the end of this line would land outside any comment or string. */
  appendable: boolean;
  /** Whether the line carries no code at all (blank, or comment-only). */
  blank: boolean;
  /** Column of the first code character, or -1 when blank. */
  indent: number;
}

export interface StatementSegment {
  /** 0-based position among the cell's top-level statements - the `M` in Almond's `resN_M`. */
  index: number;
  /** 0-based line within the cell where the statement starts. */
  startLine: number;
  /** 0-based line within the cell where the statement ends, inclusive. */
  endLine: number;
  /** False for definitions, imports and `end` markers - the things Almond does not bind. */
  isExpression: boolean;
}

/**
 * Filler for string and backtick-identifier contents. Deliberately not a space: blanking
 * `val s = "x"` to `val s =` would leave a trailing `=` that reads as a line continuation,
 * silently merging the next statement into this one.
 */
const LITERAL_FILL = "x";

interface ScanState {
  inBlockComment: boolean;
  inTripleString: boolean;
  depth: number;
}

/**
 * A line opening with one of these is a continuation of the previous line, not a new statement.
 * `case` is excluded when it opens a `case class`/`case object` definition rather than a match arm.
 */
const CONTINUES_PREVIOUS =
  /^(?:\.|\)|\]|\}|,|=>|<-|=|\+|-|\*|\/|%|\||&|\^|<|>|:|else\b|then\b|do\b|yield\b|catch\b|finally\b|match\b|case\b(?!\s+(?:class|object)\b)|with\b|extends\b|derives\b)/;

/** A line closing with one of these cannot be the end of a statement. */
const EXPECTS_CONTINUATION =
  /(?:=>|<-|=|\+|-|\*|\/|%|\||&|\^|<|>|:|,|\.|\(|\[|\{)$|\b(?:if|else|then|do|yield|while|for|match|new|with|extends|derives|return|throw)$/;

/**
 * A wildcard `import a.*` (or `export a.*`) ends in exactly what `EXPECTS_CONTINUATION` reads
 * as a trailing infix `*`, yet it is a complete statement.
 *
 * Left to that reading, the statement on the next line is segmented as part of the import:
 * it loses its own `resN_M` - the merged statement now opens with `import`, which Almond
 * binds nothing for - and every `M` after it drifts from the number the kernel gave it.
 * Nothing else ends in `.*`: a line genuinely continuing with an infix `*` has an operand
 * before it, not a selector dot.
 */
const COMPLETE_WILDCARD_IMPORT = /^(?:import|export)\b.*\.\*$/;

/** Whether `code` - a line's blanked text, trimmed - leaves its statement unfinished. */
function expectsContinuation(code: string): boolean {
  return EXPECTS_CONTINUATION.test(code) && !COMPLETE_WILDCARD_IMPORT.test(code);
}

/** Statements opening with one of these are definitions; Almond gives them no `resN_M`. */
const DEFINITION_START =
  /^(?:@|import\b|export\b|package\b|val\b|var\b|def\b|lazy\b|given\b|type\b|class\b|object\b|trait\b|enum\b|case\b|implicit\b|final\b|sealed\b|abstract\b|private\b|protected\b|override\b|inline\b|opaque\b|transparent\b|extension\b|end\b)/;

function scanLine(line: string, state: ScanState): ScannedLine {
  const depthBefore = state.depth;
  let code = "";
  let i = 0;
  let inLineComment = false;
  let unterminated = false;

  const blanks = (n: number) => " ".repeat(n);
  const filled = (n: number) => LITERAL_FILL.repeat(n);

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        code += blanks(2);
        i += 2;
      } else {
        code += " ";
        i += 1;
      }
      continue;
    }

    if (state.inTripleString) {
      if (ch === '"' && next === '"' && line[i + 2] === '"') {
        state.inTripleString = false;
        code += filled(3);
        i += 3;
      } else {
        code += LITERAL_FILL;
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      break;
    }
    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      code += blanks(2);
      i += 2;
      continue;
    }
    if (ch === '"' && next === '"' && line[i + 2] === '"') {
      state.inTripleString = true;
      code += filled(3);
      i += 3;
      continue;
    }
    if (ch === '"') {
      code += LITERAL_FILL;
      i += 1;
      while (i < line.length && line[i] !== '"') {
        const escaped = line[i] === "\\";
        code += LITERAL_FILL;
        i += 1;
        if (escaped && i < line.length) {
          code += LITERAL_FILL;
          i += 1;
        }
      }
      if (i < line.length) {
        code += LITERAL_FILL;
        i += 1;
      } else {
        unterminated = true;
      }
      continue;
    }
    if (ch === "`") {
      code += LITERAL_FILL;
      i += 1;
      while (i < line.length && line[i] !== "`") {
        code += LITERAL_FILL;
        i += 1;
      }
      if (i < line.length) {
        code += LITERAL_FILL;
        i += 1;
      } else {
        unterminated = true;
      }
      continue;
    }
    if (ch === "'" && next !== undefined) {
      // A char literal ('a', '\n'). Anything else starting with ' - a Scala 3 quoted
      // expression '{...}, say - falls through and is scanned as ordinary code.
      if (next === "\\") {
        let j = i + 2;
        while (j < line.length && line[j] !== "'") {
          j += 1;
        }
        if (j < line.length) {
          code += filled(j - i + 1);
          i = j + 1;
          continue;
        }
      } else if (line[i + 2] === "'") {
        code += filled(3);
        i += 3;
        continue;
      }
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      state.depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      state.depth -= 1;
    }
    code += ch;
    i += 1;
  }

  // A line comment is dropped above; pad so `code` stays column-aligned with `line`.
  if (code.length < line.length) {
    code += blanks(line.length - code.length);
  }

  const indent = code.search(/\S/);
  return {
    code,
    depthBefore,
    depthAfter: state.depth,
    appendable: !inLineComment && !state.inBlockComment && !state.inTripleString && !unterminated,
    blank: indent < 0,
    indent,
  };
}

export function scanLines(lines: string[]): ScannedLine[] {
  const state: ScanState = { inBlockComment: false, inTripleString: false, depth: 0 };
  return lines.map((line) => scanLine(line, state));
}

/**
 * Split a cell's lines into top-level statements, or return undefined if the cell
 * can't be read confidently - unbalanced brackets, or a first statement that doesn't
 * begin at column 0 (which would throw the `M` indices off by an unknown amount).
 */
export function segmentStatements(lines: string[]): StatementSegment[] | undefined {
  const scanned = scanLines(lines);
  if (scanned.length === 0) {
    return [];
  }
  if (scanned.some((line) => line.depthBefore < 0 || line.depthAfter < 0)) {
    return undefined;
  }
  if (scanned[scanned.length - 1].depthAfter !== 0) {
    return undefined;
  }

  const starts: number[] = [];
  let previousCode = -1;
  for (let i = 0; i < scanned.length; i++) {
    const line = scanned[i];
    if (line.blank) {
      continue;
    }
    const trimmed = line.code.trim();
    const startsStatement =
      line.depthBefore === 0 &&
      line.indent === 0 &&
      !CONTINUES_PREVIOUS.test(trimmed) &&
      (previousCode < 0 || !expectsContinuation(scanned[previousCode].code.trim()));
    if (startsStatement) {
      starts.push(i);
    }
    previousCode = i;
  }

  const firstCode = scanned.findIndex((line) => !line.blank);
  if (firstCode < 0) {
    return [];
  }
  if (starts.length === 0 || starts[0] !== firstCode) {
    // The cell opens mid-statement as far as we can tell; every index would be a guess.
    return undefined;
  }

  return starts.map((start, k) => {
    const nextStart = k + 1 < starts.length ? starts[k + 1] : scanned.length;
    let endLine = start;
    for (let i = start; i < nextStart; i++) {
      if (!scanned[i].blank) {
        endLine = i;
      }
    }
    return {
      index: k,
      startLine: start,
      endLine,
      isExpression: !DEFINITION_START.test(scanned[start].code.trim()),
    };
  });
}

/**
 * What a cell's top-level definitions introduce into the scope holding them, used to
 * decide when a later cell has to be nested so it can shadow an earlier one (see
 * `planScopes` in transform.ts).
 */
export interface DefinedNames {
  /** Names read confidently off a definition. */
  names: string[];
  /**
   * True when a definition names something we could not read: an `extension` block, an
   * anonymous `given`, an `export`, or a cell that would not segment. Callers must treat
   * it as "this may define anything", because we cannot rule out a collision.
   */
  unknown: boolean;
}

const NOTHING: DefinedNames = { names: [], unknown: false };
const UNKNOWN: DefinedNames = { names: [], unknown: true };

/** Modifiers and soft keywords that may precede the keyword naming the definition. */
const MODIFIERS = new Set([
  "private", "protected", "final", "sealed", "abstract", "implicit", "override",
  "lazy", "inline", "opaque", "transparent", "open", "case", "infix", "erased",
]);

const ALPHANUMERIC_ID = /^[A-Za-z_][A-Za-z0-9_$]*/;
const OPERATOR_ID = /^[!#%&*+\-/:<=>?@\\^|~]+/;
/** A `val`/`var` target simple enough to read: `x`, `a, b`, or `(a, b)`. */
const SIMPLE_TARGET = /^\(?\s*(?:[A-Za-z_][A-Za-z0-9_$]*|_)(?:\s*,\s*(?:[A-Za-z_][A-Za-z0-9_$]*|_))*\s*\)?$/;

/** Skip a balanced bracket group at the head of `text`, or undefined if it never closes. */
function skipGroup(text: string, open: string, close: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(i + 1).trimStart();
      }
    }
  }
  return undefined;
}

function named(match: RegExpExecArray | null): DefinedNames {
  return match ? { names: [match[0]], unknown: false } : UNKNOWN;
}

/** Strip annotations and modifiers, leaving the keyword that names the definition. */
function stripPrefixes(statement: string): string | undefined {
  let rest = statement;
  for (;;) {
    if (rest.startsWith("@")) {
      const annotation = ALPHANUMERIC_ID.exec(rest.slice(1));
      if (!annotation) {
        return undefined;
      }
      rest = rest.slice(1 + annotation[0].length).trimStart();
      while (rest.startsWith(".")) {
        const part = ALPHANUMERIC_ID.exec(rest.slice(1));
        if (!part) {
          return undefined;
        }
        rest = rest.slice(1 + part[0].length).trimStart();
      }
      if (rest.startsWith("(")) {
        const after = skipGroup(rest, "(", ")");
        if (after === undefined) {
          return undefined;
        }
        rest = after;
      }
      continue;
    }
    const word = ALPHANUMERIC_ID.exec(rest);
    if (!word || !MODIFIERS.has(word[0])) {
      return rest;
    }
    rest = rest.slice(word[0].length).trimStart();
    if ((word[0] === "private" || word[0] === "protected") && rest.startsWith("[")) {
      const after = skipGroup(rest, "[", "]");
      if (after === undefined) {
        return undefined;
      }
      rest = after;
    }
  }
}

/** Names one top-level definition introduces. `statement` is scanned code, on one line. */
export function statementNames(statement: string): DefinedNames {
  const head = stripPrefixes(statement.trim());
  if (head === undefined) {
    return UNKNOWN;
  }
  const keyword = ALPHANUMERIC_ID.exec(head);
  if (!keyword) {
    return UNKNOWN;
  }
  const rest = head.slice(keyword[0].length).trimStart();

  switch (keyword[0]) {
    case "import":
    case "package":
    case "end":
      // `end` closes a definition made earlier in the same statement run; `import` and
      // `package` bind nothing that a later cell could collide with by *defining*.
      return NOTHING;
    case "class":
    case "trait":
    case "object":
    case "enum":
    case "type":
      return named(ALPHANUMERIC_ID.exec(rest));
    case "def":
      return named(ALPHANUMERIC_ID.exec(rest) ?? OPERATOR_ID.exec(rest));
    case "given": {
      // Only the named form (`given intOrd: Ordering[Int] = ...`) tells us anything; an
      // anonymous given still gets a compiler-mangled name that a second one would clash with.
      const name = ALPHANUMERIC_ID.exec(rest);
      return name && rest.slice(name[0].length).trimStart().startsWith(":")
        ? { names: [name[0]], unknown: false }
        : UNKNOWN;
    }
    case "val":
    case "var": {
      // Everything before the type ascription or the `=` is the binding target.
      const cut = rest.search(/[:=]/);
      const target = (cut < 0 ? rest : rest.slice(0, cut)).trim();
      if (!SIMPLE_TARGET.test(target)) {
        // A destructuring or extractor pattern (`val Some(x) = o`); we cannot read it.
        return UNKNOWN;
      }
      const names = target
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && part !== "_");
      return { names, unknown: false };
    }
    default:
      // `export`, `extension`, and anything our statement scanner mislabelled.
      return UNKNOWN;
  }
}

/**
 * Aggregate the names a cell's top-level definitions introduce. `segments` is what
 * `segmentStatements` returned for the same lines; `undefined` (the cell could not be
 * read) is reported as `unknown`, since it may define anything.
 */
export function definedNames(lines: string[], segments: StatementSegment[] | undefined): DefinedNames {
  if (!segments) {
    return UNKNOWN;
  }
  const scanned = scanLines(lines);
  const names: string[] = [];
  let unknown = false;
  for (const segment of segments) {
    if (segment.isExpression) {
      continue;
    }
    const statement = scanned
      .slice(segment.startLine, segment.endLine + 1)
      .map((line) => line.code)
      .join(" ");
    const result = statementNames(statement);
    names.push(...result.names);
    unknown = unknown || result.unknown;
  }
  return { names, unknown };
}
