import type * as vscode from "vscode";
import {
  definedNames,
  ScannedLine,
  scanLines,
  segmentStatements,
  StatementSegment,
} from "./statements";

/**
 * Pure transform: notebook cells -> shadow file text + line mapping.
 * Deliberately free of any VS Code runtime dependency (only type-only
 * imports for the Uri type) so it can be unit tested with plain
 * `node --test`, without an extension host.
 */

export interface ScalaNotebookConfig {
  scalaVersion: string;
  mvnDeps: string[];
  preamble: string[];
  /**
   * Ammonite version whose `repl`/`interp` bridges the shadow file puts in scope (see
   * `prelude`). Empty or undefined leaves them out.
   */
  ammoniteVersion?: string;
  /**
   * Almond version whose predef the shadow file reproduces (see `prelude`).
   * Empty or undefined leaves it out.
   */
  almondVersion?: string;
  /**
   * Identifier for the object every cell body is nested in (see `transform`).
   * Defaults to `NotebookCells`; ShadowManager passes the shadow file's base
   * name so two shadow files sharing a Metals build target can't collide.
   */
  wrapperObjectName?: string;
}

/** A minimal, decoupled view of a notebook cell used as transform input. */
export interface SourceCell {
  /** Index of this cell in notebook.getCells(). */
  index: number;
  isCode: boolean;
  languageId: string;
  text: string;
  uri: vscode.Uri;
}

export interface CellSpan {
  cellIndex: number;
  cellUri: vscode.Uri;
  /** 0-based line in the shadow file where this cell's first content line starts. */
  startLine: number;
  /** Real lines belonging to this cell (excludes any synthesized trailing newline). */
  lineCount: number;
}

export interface ShadowMapping {
  /** Lines occupied by the header, wrapper opening and preamble, before the first cell marker. */
  headerLines: number;
  /** Spans sorted ascending by startLine. */
  spans: CellSpan[];
}

export interface TransformResult {
  text: string;
  mapping: ShadowMapping;
}

const DEFAULT_WRAPPER_OBJECT_NAME = "NotebookCells";

/**
 * Scala 3 rejects statements at the top level of a `.scala` file ("Illegal start
 * of toplevel definition"), and Mill splices a script's body in at exactly that
 * position. Almond sidesteps this by wrapping each cell in an object, where a
 * bare statement is simply part of the template body; we wrap for the same reason.
 */
const SCALA_KEYWORDS = new Set([
  "abstract", "case", "catch", "class", "def", "do", "else", "end", "enum", "export",
  "extends", "extension", "false", "final", "finally", "for", "given", "if", "implicit",
  "import", "lazy", "match", "new", "null", "object", "override", "package", "private",
  "protected", "return", "sealed", "super", "then", "this", "throw", "trait", "true",
  "try", "type", "val", "var", "while", "with", "yield",
]);

/**
 * Inside the wrapper a cell's trailing bare expression (`1 + 1`, `df.show`) is a
 * discarded statement, so scalac warns on it. In a notebook that expression is the
 * cell's result - Almond binds it to `resN` - so the warning is pure noise and would
 * otherwise squiggle idiomatic cells.
 */
const PURE_EXPRESSION_WCONF = "-Wconf:msg=A pure expression does nothing in statement position:s";

/**
 * The artifact carrying the names Almond's own predef imports.
 *
 * `jupyter-api` is used rather than `scala-kernel-api`, which is what a notebook's
 * `import $ivy` would name: it is cross-published against the Scala *binary* version
 * (`_3`), so it resolves for whatever `scalaVersion` is configured, whereas
 * `scala-kernel-api` is published per *full* Scala version and only for the ones
 * Almond ships a kernel for. It also carries `almond.display` without pulling in the
 * Ammonite compiler. The cost is the two predef names it does not hold:
 * `almond.display.PrettyPrint`, and `almond.api.JupyterAPIHolder` (generated per
 * kernel) - see `ALMOND_PRELUDE` for how the latter is stood in for.
 */
function almondApiCoordinate(version: string): string {
  return `sh.almond::jupyter-api:${version}`;
}

/** `com.github.jupyter:jvm-repr`, which `jupyter-api` depends on, is only published here. */
const JITPACK_REPOSITORY = "https://jitpack.io";

/**
 * The artifact holding the `repl` and `interp` bridges, plus the Ammonite API they
 * expose (`repl.sess`, `repl.pprinter`, `interp.load`, ...) and its own transitive
 * classpath - os-lib, pprint, fansi - which a cell can use unqualified in a real kernel
 * too, since Ammonite puts it in scope there as well.
 *
 * Ammonite publishes this per *full* Scala version, and not for every one Scala has
 * released (`3.7.2`, the default `scalaVersion` here, is missing). Rather than track the
 * configured version and break whenever it has no build, the coordinate is pinned to the
 * LTS line: Scala 3 reads TASTy written by any earlier 3.x, so a `_3.3.7` artifact
 * compiles against every later Scala 3. An *earlier* `scalaVersion` than this is the one
 * case it cannot serve; set `ammoniteVersion` to "" and use `mvnDeps`/`preamble` there.
 */
const AMMONITE_API_SCALA_VERSION = "3.3.7";

function ammoniteApiCoordinate(version: string): string {
  return `com.lihaoyi:ammonite-repl-api_${AMMONITE_API_SCALA_VERSION}:${version}`;
}

/**
 * Ammonite's half of the predef: the `interp` and `repl` bridges that
 * `Interpreter.initializePredef` installs, and the implicits `Defaults.replImports`
 * pulls off `repl`.
 *
 * These are the real holders, not stand-ins. `APIHolder.value` only has a value once a
 * kernel assigns one, but it type-checks without, which is all the shadow file needs.
 */
const AMMONITE_PRELUDE = [
  "import _root_.ammonite.interp.api.InterpBridge.{value => interp}",
  "import _root_.ammonite.repl.ReplBridge.{value => repl}",
  "import _root_.ammonite.repl.ReplBridge.value.{codeColorsImplicit, tprintColorsImplicit, show}",
];

/**
 * Almond's hardcoded predef, so a cell can write `Markdown("# Hello World")` or
 * `publish.stdout(...)` the way it does in a real notebook. Mirrors `almondImports` in
 * Almond's `AmmInterpreter`, minus `PrettyPrint` (not in `jupyter-api`) and flattened
 * onto single lines, since nothing maps back to these.
 *
 * Almond binds `kernel` to a live `JupyterApi` through a per-kernel `JupyterAPIHolder`
 * that `jupyter-api` does not carry, so unlike the Ammonite bridges this one is declared
 * and never assigned. That is enough for name resolution - the shadow file exists only
 * to be compiled, never to run.
 */
const ALMOND_PRELUDE = [
  "import almond.display.{Data, Display, FileLink, Html, IFrame, Image, Javascript, Json, Latex, Markdown, Math, ProgressBar, Svg, Text, TextDisplay, UpdatableDisplay}",
  "import almond.display.Display.{html, js, latex, markdown, svg, text}",
  "import almond.interpreter.api.DisplayData.DisplayDataSyntax",
  "import almond.input.Input",
  "val kernel: almond.api.JupyterApi = ???",
  "import kernel.{publish, commHandler}",
  "import kernel.publish.display",
];

interface Prelude {
  mvnDeps: string[];
  repositories: string[];
  preamble: string[];
}

/**
 * What the configured Ammonite and Almond versions contribute to the header and the
 * preamble. Ammonite goes first, as it does in Almond's own predef, so an Almond import
 * of the same name would win.
 */
function prelude(config: ScalaNotebookConfig): Prelude {
  const result: Prelude = { mvnDeps: [], repositories: [], preamble: [] };

  const ammoniteVersion = config.ammoniteVersion?.trim();
  if (ammoniteVersion) {
    result.mvnDeps.push(ammoniteApiCoordinate(ammoniteVersion));
    result.preamble.push(...AMMONITE_PRELUDE);
  }

  const almondVersion = config.almondVersion?.trim();
  if (almondVersion) {
    result.mvnDeps.push(almondApiCoordinate(almondVersion));
    result.repositories.push(JITPACK_REPOSITORY);
    result.preamble.push(...ALMOND_PRELUDE);
  }

  return result;
}

/**
 * Ammonite/Almond "magic" imports. None are legal Scala, so any line using one is
 * commented out to keep it from erroring. `$ivy`/`$dep`/`$repo` additionally feed the
 * Mill header; `$file`, `$plugin`, `$scalac` and `$profile` have no shadow-file
 * equivalent and are only neutralized.
 */
const MAGIC_IMPORT_LINE_RE = /^\s*import\s+\$(?:ivy|dep|repo|file|plugin|scalac|profile)\b/;

/** One `$ivy`/`$dep`/`$repo` term: either a single backticked coordinate or a braced group. */
const MAGIC_TERM_RE = /(\$plugin\.)?\$(ivy|dep|repo)\.\s*(?:`([^`]+)`|\{([^}]*)\})/g;

const BACKTICKED_RE = /`([^`]+)`/g;

interface MagicImports {
  mvnDeps: string[];
  repositories: string[];
}

/** Split cell text into its real document lines, dropping one synthesized trailing empty line. */
function realLines(text: string): string[] {
  const hadTrailingNewline = text.endsWith("\n");
  const raw = text.split("\n");
  if (hadTrailingNewline) {
    // text.split("\n") on "foo\nbar\n" yields ["foo","bar",""] - the trailing ""
    // is not a real document line, it's just where the trailing newline landed.
    raw.pop();
  }
  return raw;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Comment a line out without changing any column before its end. A block comment is used
 * so a `resN_M` opener can still be appended after it (see `planResultBindings`); the
 * `/* [shadow] ` prefix is the same width as the `// [shadow] ` one it replaces.
 */
function commentOut(line: string): string {
  if (line.includes("*/")) {
    // Can't nest it safely; fall back to a line comment and forgo appending here.
    return `// [shadow] ${line}`;
  }
  return `/* [shadow] ${line} */`;
}

function backtickedTerms(text: string): string[] {
  const out: string[] = [];
  BACKTICKED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BACKTICKED_RE.exec(text)) !== null) {
    out.push(match[1]);
  }
  return out;
}

/**
 * Almond resolves a `_` version against its own build (e.g. `sh.almond::scala-kernel-api:_`).
 * We have no such mapping, so the coordinate is dropped rather than written into the
 * header, where Mill would fail to resolve it and bury every real diagnostic.
 */
function isResolvableCoordinate(coordinate: string): boolean {
  return !coordinate.endsWith(":_");
}

/**
 * If `line` is a magic import, record what it contributes to the Mill header and
 * report true so the caller comments the line out. Returns false for ordinary Scala.
 */
function collectMagicImports(line: string, into: MagicImports): boolean {
  if (!MAGIC_IMPORT_LINE_RE.test(line)) {
    return false;
  }

  MAGIC_TERM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MAGIC_TERM_RE.exec(line)) !== null) {
    const [, plugin, kind, single, braced] = match;
    if (plugin) {
      // `$plugin.$ivy` asks for a compiler plugin, not a classpath entry; putting it
      // in mvnDeps would neither enable the plugin nor help name resolution.
      continue;
    }
    const terms = single !== undefined ? [single] : backtickedTerms(braced ?? "");
    for (const term of terms) {
      const value = term.trim();
      if (value.length === 0) {
        continue;
      }
      if (kind === "repo") {
        into.repositories.push(value);
      } else if (isResolvableCoordinate(value)) {
        into.mvnDeps.push(value);
      }
    }
  }
  return true;
}

function wrapperObjectName(config: ScalaNotebookConfig): string {
  const name = config.wrapperObjectName;
  if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SCALA_KEYWORDS.has(name)) {
    return name;
  }
  return DEFAULT_WRAPPER_OBJECT_NAME;
}

export function selectScalaCodeCells(cells: SourceCell[]): SourceCell[] {
  return cells.filter((c) => c.isCode && c.languageId === "scala");
}

interface CellBindings {
  /** Text appended to a cell line, keyed by line index; -1 is the cell marker line. */
  openers: Map<number, string>;
  /** Closing parens appended to a cell line, keyed by line index. */
  closers: Map<number, string>;
  /** Whole synthesized lines emitted after the cell body. */
  aliases: string[];
}

/**
 * Plan Almond's `resN_M` result bindings for one cell.
 *
 * Every binding is added by *appending only* - the opener `val resN_M = (` goes on the end
 * of the line before the statement, the `)` on the end of the statement's last line - so no
 * cell line changes width before its end and no line is inserted. Cell line numbers and
 * column positions therefore survive untouched, and the mapping needs no adjustment at all.
 *
 * A binding is skipped whenever either line ends inside a comment or string, where appended
 * code would be swallowed or would break the line. Skipping costs a `resN_M`; emitting into
 * a comment would produce an unbalanced paren and a cascade of phantom errors.
 */
function planResultBindings(
  cellPosition: number,
  segments: StatementSegment[] | undefined,
  emitted: ScannedLine[]
): CellBindings {
  const bindings: CellBindings = { openers: new Map(), closers: new Map(), aliases: [] };
  if (!segments) {
    return bindings;
  }

  for (const segment of segments) {
    if (!segment.isExpression) {
      continue;
    }
    // Lines carrying no code (blank, or comment-only) can be stepped over: the opener's
    // paren spans them harmlessly, and they can't belong to the previous statement.
    let before = segment.startLine - 1;
    while (before >= 0 && emitted[before].blank && !emitted[before].appendable) {
      before -= 1;
    }
    if (before >= 0 && !emitted[before].appendable) {
      continue;
    }
    if (!emitted[segment.endLine].appendable) {
      continue;
    }
    if (bindings.openers.has(before) || bindings.closers.has(segment.endLine)) {
      continue;
    }

    const name = `res${cellPosition}_${segment.index}`;
    // The marker line holds no statement, and a blank line needs no separator either.
    const separator = before >= 0 && !emitted[before].blank ? " ;" : "";
    bindings.openers.set(before, `${separator} val ${name} = (`);
    bindings.closers.set(segment.endLine, ")");
    if (segments.length === 1) {
      // Ammonite drops the suffix when a cell holds a single statement; bind both spellings
      // rather than gamble on which one the user saw in their kernel output.
      bindings.aliases.push(`val res${cellPosition} = ${name}`);
    }
  }

  return bindings;
}

interface PreparedCell {
  /** The cell's real lines, exactly as the user wrote them. */
  source: string[];
  /** `source` with magic imports commented out; what actually gets emitted. */
  rewritten: string[];
  /** Segmentation of `source`, or undefined when the cell could not be read. */
  segments: StatementSegment[] | undefined;
}

/**
 * Name of the objects opened to give a redefining cell a scope of its own. Backticked and
 * containing spaces, so it can never collide with a name a user could write; nothing ever
 * refers to it by name anyway, since the nesting is purely lexical.
 */
const SCOPE_OBJECT_PREFIX = "shadow scope ";

/**
 * How deep cells may be nested. Redefinitions are rare enough that real notebooks stay far
 * below this; the cap exists because a few hundred levels of nesting overflows the Scala
 * compiler's stack, which would cost every diagnostic in the file rather than the single
 * duplicate-definition error the nesting was there to avoid.
 */
const MAX_NESTED_SCOPES = 100;

/**
 * Decide which cells have to open a nested object of their own.
 *
 * Almond compiles each cell into its own wrapper and imports the previous cell's names into
 * it, so a definition in a later cell simply shadows an earlier one of the same name. Here
 * the same effect comes from lexical nesting: once a cell redefines a name its scope already
 * holds, it and every cell after it are emitted one object deeper, where the new definition
 * shadows the old and everything else - imports, givens, extensions, types - stays in scope.
 *
 * Nesting only on a collision keeps the file flat for ordinary notebooks. Opening a scope is
 * always safe (it can only hide an earlier definition, which is exactly the intent), so an
 * unreadable definition is treated as a collision; missing one only costs the
 * duplicate-definition error we would otherwise have reported anyway.
 *
 * The preamble sits in the same scope as the first cell, so its names seed the scope too:
 * a cell defining `kernel` shadows the prelude's binding instead of duplicating it.
 */
function planScopes(cells: PreparedCell[], preamble: string[]): boolean[] {
  const seed = definedNames(preamble, segmentStatements(preamble));
  let scope = new Set<string>(seed.names);
  let scopeHasUnreadable = seed.unknown;
  let depth = 0;

  return cells.map(({ source, segments }) => {
    const defined = definedNames(source, segments);
    const shadows =
      defined.names.some((name) => scope.has(name)) ||
      // We cannot name what this cell defines, so we cannot rule out a collision - unless
      // the scope holds nothing yet, in which case there is nothing to collide with.
      (defined.unknown && (scope.size > 0 || scopeHasUnreadable));

    const opens = shadows && depth < MAX_NESTED_SCOPES;
    if (opens) {
      depth += 1;
      scope = new Set();
      scopeHasUnreadable = false;
    }
    for (const name of defined.names) {
      scope.add(name);
    }
    scopeHasUnreadable = scopeHasUnreadable || defined.unknown;
    return opens;
  });
}

/**
 * Emit the shadow script. Cell bodies are copied verbatim - never re-indented - into the
 * wrapper object, one line per source line, so a cell's line N is always the shadow's
 * line `span.startLine + N`. Cells share one scope until one of them redefines a name,
 * at which point it and the cells after it are nested one object deeper (see
 * `planScopes`), which is what lets a later cell shadow an earlier definition.
 */
export function transform(cells: SourceCell[], config: ScalaNotebookConfig): TransformResult {
  const codeCells = selectScalaCodeCells(cells);

  const magic: MagicImports = { mvnDeps: [], repositories: [] };
  const prepared: PreparedCell[] = codeCells.map((cell) => {
    const source = realLines(cell.text);
    return {
      source,
      // Statements are read from the *original* text: Almond counts an `import $ivy` line as a
      // statement, so segmenting the rewritten (commented-out) lines would shift every M index.
      segments: segmentStatements(source),
      rewritten: source.map((line) => (collectMagicImports(line, magic) ? commentOut(line) : line)),
    };
  });
  const predef = prelude(config);
  const preamble = [...predef.preamble, ...config.preamble];
  const opensScope = planScopes(prepared, preamble);

  const allDeps = dedupe([...predef.mvnDeps, ...config.mvnDeps, ...magic.mvnDeps]);
  const repositories = dedupe([...predef.repositories, ...magic.repositories]);

  const directives: string[] = [`//| scalaVersion: ${config.scalaVersion}`];
  if (repositories.length > 0) {
    directives.push("//| repositories:");
    for (const repository of repositories) {
      directives.push(`//| - ${repository}`);
    }
  }
  if (allDeps.length > 0) {
    directives.push("//| mvnDeps:");
    for (const dep of allDeps) {
      directives.push(`//| - ${dep}`);
    }
  }
  directives.push("//| scalacOptions:", `//| - ${PURE_EXPRESSION_WCONF}`);

  const outLines: string[] = [...directives, `object ${wrapperObjectName(config)} {`, ...preamble];
  const headerLines = outLines.length;
  const spans: CellSpan[] = [];
  let openScopes = 0;

  codeCells.forEach((cell, i) => {
    const { rewritten: lines, segments } = prepared[i];
    const bindings = planResultBindings(i + 1, segments, scanLines(lines));

    if (opensScope[i]) {
      openScopes += 1;
      outLines.push(`object \`${SCOPE_OBJECT_PREFIX}${openScopes}\` {`);
    }
    outLines.push(`/* --- cell ${cell.index} ${cell.uri.fragment} */${bindings.openers.get(-1) ?? ""}`);
    const startLine = outLines.length;
    lines.forEach((line, lineIndex) => {
      // Order matters: a line can close one statement and open the next.
      outLines.push(`${line}${bindings.closers.get(lineIndex) ?? ""}${bindings.openers.get(lineIndex) ?? ""}`);
    });
    spans.push({
      cellIndex: cell.index,
      cellUri: cell.uri,
      startLine,
      lineCount: lines.length,
    });
    // Emitted after the span, so they shift nothing inside the cell.
    for (const alias of bindings.aliases) {
      outLines.push(alias);
    }
  });

  for (let i = 0; i <= openScopes; i++) {
    outLines.push("}");
  }

  const text = outLines.join("\n") + "\n";

  return {
    text,
    mapping: {
      headerLines,
      spans,
    },
  };
}
