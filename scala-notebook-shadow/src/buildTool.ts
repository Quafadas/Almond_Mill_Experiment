/**
 * Which build server compiles the shadow scripts, and the file-naming that follows from it.
 *
 * Two targets are supported because they fail differently, not because both are wanted in
 * the end. Mill is the original (issue #1): it works, at the cost of a `Metals: Import
 * Build` for every new notebook and every changed dependency, because one Mill script is
 * one build target. scala-cli is the candidate replacement (issue #15): Metals starts a
 * separate scala-cli BSP server for a directory of `.sc` files on its own, and scala-cli
 * resolves `//> using dep` itself, so a new notebook is a new *source* rather than a new
 * target - which is what would remove the reimport step.
 *
 * Issue #15's probes §5.4-§5.11 are still open, so Mill stays the default and this is the
 * switch that makes those probes runnable against the real extension rather than
 * hand-written files.
 */

export type BuildTool = "mill" | "scala-cli";

export const BUILD_TOOLS: BuildTool[] = ["mill", "scala-cli"];

export function isBuildTool(value: string): value is BuildTool {
  return (BUILD_TOOLS as string[]).includes(value);
}

/**
 * The extension a shadow script must carry for its build server to claim it.
 *
 * Mill compiles single-file `.scala` scripts. scala-cli's Metals integration keys off `.sc`
 * specifically: a `.scala` file in the same directory would be read as an ordinary source,
 * not a script, and would not get the dedicated BSP server that makes this worth trying.
 */
export function shadowFileExtension(buildTool: BuildTool): string {
  return buildTool === "scala-cli" ? ".sc" : ".scala";
}
