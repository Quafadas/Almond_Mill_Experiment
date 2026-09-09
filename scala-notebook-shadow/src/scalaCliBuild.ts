/**
 * scala-cli does not hand the `.sc` straight to the compiler: it generates a wrapper for it
 * under `.scala-build/`. Whether Metals reports diagnostics against that wrapper or against
 * the `.sc` - which its `workspace/wrappedSources` support exists to allow - is issue #15
 * §5.4, still unanswered.
 *
 * Nothing is relayed from a wrapper. It carries no marker naming the script it came from, so
 * the line offset would be a guess, and a wrong guess puts squiggles on the wrong lines of
 * the wrong cell. This predicate exists so the log can say a diagnostic arrived and where,
 * which is what the probe needs to see: the alternative is a silent drop that reads as
 * "scala-cli reported nothing".
 */
export function looksLikeScalaCliGeneratedSource(fsPath: string): boolean {
  return fsPath.endsWith(".scala") && /[\\/]\.scala-build[\\/]/.test(fsPath);
}
