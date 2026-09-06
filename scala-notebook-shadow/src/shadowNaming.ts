/**
 * A notebook's shadow script is named after the notebook's path within the workspace:
 * `analysis/sample.ipynb` -> `analysis_sample.scala`, wrapping cells in `object analysis_sample`.
 *
 * Deriving the name from the path, rather than handing names out as notebooks open, means
 * one notebook maps to exactly one shadow file: reopening a notebook overwrites its shadow
 * instead of allocating another, the name is the same in every session, and two notebooks
 * sharing a basename in different directories still can't collide. Nothing has to be
 * released when a notebook closes, so there is no bookkeeping to leak.
 */
export function shadowBaseName(relativePath: string): string {
  const withoutExtension = relativePath.replace(/\.[^./\\]+$/, "");
  const sanitized = withoutExtension.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

  if (sanitized.length === 0) {
    return "notebook";
  }
  // A Scala identifier can't open with a digit, but a notebook name can.
  return /^[0-9]/.test(sanitized) ? `NB_${sanitized}` : sanitized;
}
