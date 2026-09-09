/**
 * Mill does not compile a single-file script where it sits. It copies the script into a
 * task's `.dest/` directory, prepending two marker lines, and compiles that copy:
 *
 *     //SOURCECODE_ORIGINAL_FILE_PATH=/abs/path/notebook-shadow/sample.scala
 *     //SOURCECODE_ORIGINAL_CODE_START_MARKER
 *     //| scalaVersion: 3.7.2
 *     ...
 *
 * Metals reports diagnostics against that copy, not against the shadow file, so the relay
 * has to recognise it and shift line numbers back. The markers are self-describing, which
 * is why the offset is read from the file rather than hardcoded to 2.
 */

export interface GeneratedSourceHeader {
  /** Absolute path of the file the copy was generated from. */
  originalPath: string;
  /** Lines Mill prepended, i.e. what to subtract from a reported line number. */
  lineOffset: number;
}

const ORIGINAL_PATH_PREFIX = "//SOURCECODE_ORIGINAL_FILE_PATH=";
const START_MARKER = "//SOURCECODE_ORIGINAL_CODE_START_MARKER";

/** How far in to look before giving up; the markers are the first thing in the file. */
const MAX_HEADER_LINES = 8;

export function parseGeneratedSourceHeader(text: string): GeneratedSourceHeader | undefined {
  const lines = text.split("\n", MAX_HEADER_LINES);

  let originalPath: string | undefined;
  for (const line of lines) {
    if (line.startsWith(ORIGINAL_PATH_PREFIX)) {
      originalPath = line.slice(ORIGINAL_PATH_PREFIX.length).trim();
      break;
    }
  }
  if (!originalPath) {
    return undefined;
  }

  const markerIndex = lines.findIndex((line) => line.trim() === START_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }

  return { originalPath, lineOffset: markerIndex + 1 };
}

/**
 * Cheap pre-filter, so the relay only reads files that could plausibly be a Mill copy
 * rather than stat-ing every URI diagnostics ever arrive for (library sources included).
 */
export function looksLikeGeneratedSource(fsPath: string): boolean {
  return fsPath.endsWith(".scala") && /[\\/][^\\/]+\.dest[\\/]/.test(fsPath);
}

/**
 * scala-cli also compiles a copy rather than the script itself - a wrapper generated under
 * `.scala-build/`. Whether Metals reports diagnostics against that copy or against the `.sc`
 * (which its `workspace/wrappedSources` support exists to allow) is issue #15 §5.4, still
 * unanswered.
 *
 * Nothing is relayed from here: the copy carries no marker naming the script it came from,
 * so the line offset would be a guess, and a wrong guess puts squiggles on the wrong lines.
 * It exists so the log can say a diagnostic arrived and where, which is what the probe needs
 * to see - the alternative is a silent drop that reads as "scala-cli reported nothing".
 */
export function looksLikeScalaCliGeneratedSource(fsPath: string): boolean {
  return fsPath.endsWith(".scala") && /[\\/]\.scala-build[\\/]/.test(fsPath);
}
