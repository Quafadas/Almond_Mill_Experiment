import { SHADOW_FILE_EXTENSION, shadowFileName } from "./shadowNaming";
import { CELL_MARKER_PREFIX } from "./transform";

/**
 * Deciding which shadow scripts are leftovers. Kept free of any VS Code dependency, like
 * the rest of the logic worth testing; `ShadowManager.cleanOrphanedShadows` does the
 * reading and deleting.
 *
 * Nothing removes a shadow while the extension runs: a notebook that closes leaves its
 * script on disk for the next session to reuse, and a notebook renamed or deleted outside
 * the editor is never seen again at all. So the directory only grows, and every stale
 * script in it is still compiled by the build server the shadow directory owns - slowing
 * the compile the live shadows are waiting on, and squiggling cells with duplicate
 * definitions when a renamed notebook's old and new shadows both define what it declares.
 *
 * A shadow's name is a pure function of its notebook's path within the workspace folder
 * (see {@link shadowFileName}), so the notebooks on disk say exactly which names are still
 * spoken for and any other `.sc` is a leftover. That inference only justifies a deletion
 * when the file really is one of ours, which is what {@link looksGenerated} is for.
 */

/**
 * The `.sc` names in a shadow directory that no notebook accounts for.
 *
 * Both arguments are relative to the same workspace folder: `fileNames` are the shadow
 * directory's entries, `notebookRelativePaths` the notebooks found under the folder.
 * Anything that is not a `.sc` is left alone - the directory also holds scala-cli's own
 * `.bsp` and `.scala-build`, and a user may keep a `project.scala` there.
 */
export function orphanedShadowNames(
  fileNames: readonly string[],
  notebookRelativePaths: readonly string[]
): string[] {
  const spokenFor = new Set(notebookRelativePaths.map(shadowFileName));
  return fileNames.filter((name) => name.endsWith(SHADOW_FILE_EXTENSION) && !spokenFor.has(name));
}

/**
 * Whether `text` is a shadow script this extension wrote, rather than a `.sc` that happens
 * to sit in the shadow directory.
 *
 * The cell marker is the tell: one is emitted for every cell of every shadow, and nothing
 * else has a reason to write one. Requiring it means a hand-written script whose name no
 * notebook matches is only reported, never deleted - which is the right way round, since a
 * shadow removed in error costs a regenerate and a hand-written one costs its author.
 */
export function looksGenerated(text: string): boolean {
  return text.includes(CELL_MARKER_PREFIX);
}
