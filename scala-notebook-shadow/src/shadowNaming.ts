import { createHash } from "node:crypto";
import * as path from "node:path";

/**
 * A notebook's shadow script is named after the notebook's path within the workspace:
 * `analysis/sample.ipynb` -> `analysis_sample.sc`, wrapping cells in `object analysis_sample`.
 *
 * Deriving the name from the path, rather than handing names out as notebooks open, means
 * one notebook maps to exactly one shadow file: reopening a notebook overwrites its shadow
 * instead of allocating another, the name is the same in every session, and two notebooks
 * sharing a basename in different directories still can't collide. Nothing has to be
 * released when a notebook closes, so there is no bookkeeping to leak.
 *
 * Folding a path into one identifier does not give that for free, though. Two properties
 * have to be held deliberately, and each costs a name its readability when it can't be had
 * any other way:
 *
 * Distinct paths must get distinct names. Sanitizing is lossy - every run of characters a
 * Scala identifier can't hold collapses to a single underscore - so `a_b/x.ipynb`,
 * `a-b/x.ipynb` and `a/b_x.ipynb` all reduce to `a_b_x`, and a path of non-ASCII
 * directories (`分析/sample.ipynb`, `研究/sample.ipynb`) loses its directories altogether and
 * reduces to the basename. Colliding notebooks would share one shadow file, each open
 * overwriting the other's, and cross-notebook filtering could not tell their results apart.
 * So a name that is not a faithful rendering of its path carries a hash of that path.
 *
 * Names must stay short enough to compile. See {@link MAX_BASE_NAME_LENGTH}.
 */
/**
 * scala-cli's Metals integration keys off `.sc` specifically: a `.scala` file in the same
 * directory would be read as an ordinary source rather than a script, and would not get the
 * dedicated scala-cli build server the whole approach rests on.
 */
export const SHADOW_FILE_EXTENSION = ".sc";

/** The file name a notebook at `relativePath` within the workspace folder shadows to. */
export function shadowFileName(relativePath: string): string {
  return `${shadowBaseName(relativePath)}${SHADOW_FILE_EXTENSION}`;
}

/**
 * Where a notebook sits relative to the directory holding its shadow file, POSIX-separated
 * and "" when the two share one.
 *
 * A notebook's cells write paths relative to the notebook (`import $cp.^.resources`), while
 * the directives the shadow file carries resolve relative to the shadow file. Since the
 * shadow lives in one flat directory for the whole workspace and the notebook can be
 * anywhere under it, the two bases are almost never the same place, and this is the hop
 * between them (see `ScalaNotebookConfig.notebookDirFromShadow`).
 *
 * Separators are normalized so the shadow's text is the same on Windows as on macOS, and so
 * the directive is one scala-cli reads as a path rather than as a single odd segment.
 */
export function relativeNotebookDir(shadowFsPath: string, notebookFsPath: string): string {
  return path
    .relative(path.dirname(shadowFsPath), path.dirname(notebookFsPath))
    .replace(/\\/g, "/");
}

export function shadowBaseName(relativePath: string): string {
  // Normalized first so a repo opened on Windows and on macOS derives the same name for
  // the same notebook, rather than one per separator style.
  const normalized = relativePath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^./]+$/, "");
  const sanitized = withoutExtension.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

  if (isFaithful(withoutExtension, sanitized) && sanitized.length <= MAX_BASE_NAME_LENGTH) {
    return sanitized;
  }
  return withPathHash(sanitized, normalized);
}

/**
 * The longest base name that survives the whole toolchain, with headroom.
 *
 * Measured on macOS/APFS (`NAME_MAX` 255 bytes) against scala-cli with Scala 3.7.2: the
 * binding constraint is not our own `<base>.sc`, which fits up to 252, but the package
 * object scalac emits for the script, `<base>$package$.class`, fifteen characters longer.
 * The failure at 241 is the quiet kind - the `.sc` writes, the shadow opens and looks
 * healthy, and only bloop's log carries the `File name too long` that means no cell will
 * ever get a diagnostic.
 *
 * The cap sits well below the measured 240 because that measurement is platform-specific:
 * Windows shares the 255-byte component limit but nests class files under a longer
 * `.scala-build/.bloop/<project>/bloop-internal-classes/main-<hash>/` prefix, and is
 * untested here.
 *
 * Only a genuinely long path reaches this - the name is the notebook's whole path within
 * the workspace, so 200 characters is around eleven directories of twenty characters each.
 */
const MAX_BASE_NAME_LENGTH = 200;

/**
 * Hex characters of path hash appended to a name that can't stand for its path alone.
 *
 * Forty-eight bits: a workspace would need on the order of a million notebooks whose names
 * all needed disambiguating before a collision here became as likely as one from any other
 * cause.
 */
const HASH_LENGTH = 12;

/**
 * Whether `sanitized` names exactly one path, and so needs no hash to tell it apart.
 *
 * True only when every directory and the basename is plain alphanumerics. Then the
 * underscores in the name are exactly its separators, since no segment can contain one,
 * and splitting the name recovers the path it came from.
 */
function isFaithful(withoutExtension: string, sanitized: string): boolean {
  if (sanitized.length === 0) {
    return false;
  }
  // A leading digit would have to be prefixed to make a Scala identifier, and `NB_2024`
  // is not distinguishable from a directory called `NB` holding `2024.ipynb`.
  if (/^[0-9]/.test(sanitized)) {
    return false;
  }
  return withoutExtension.split("/").every((segment) => /^[A-Za-z0-9]+$/.test(segment));
}

/** Append a hash of the full path, trimming the readable part to fit the cap around it. */
function withPathHash(sanitized: string, normalizedPath: string): string {
  const hash = createHash("sha1").update(normalizedPath).digest("hex").slice(0, HASH_LENGTH);
  // A path that sanitizes away to nothing still has a hash to be told apart by.
  const stem = sanitized.length === 0 ? "notebook" : sanitized;
  // A Scala identifier can't open with a digit, but a notebook name can.
  const prefixed = /^[0-9]/.test(stem) ? `NB_${stem}` : stem;
  // Truncating mid-path can leave the trailing underscore of a collapsed run, which would
  // read as an empty segment next to the hash's separator.
  const readable = prefixed.slice(0, MAX_BASE_NAME_LENGTH - HASH_LENGTH - 1).replace(/_+$/, "");
  return `${readable}_${hash}`;
}
