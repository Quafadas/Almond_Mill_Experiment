import * as path from "path";

/**
 * Files that mark a directory as a Mill workspace root, as relative paths from that
 * directory. Mill 0.x's `build.sc` is deliberately absent: the shadow scripts rely on
 * Mill >= 1.1's single-file script support, so a `build.sc` root couldn't compile them.
 */
export const MILL_ROOT_MARKERS = [
  "build.mill.yaml",
  "build.mill",
  "build.mill.scala",
  ".mill-version",
  path.join(".config", "mill-version"),
];

/**
 * Every directory from `startDir` up to and including `stopDir`, nearest first.
 * Empty if `startDir` doesn't lie under `stopDir`, so a notebook outside the workspace
 * never sends the walk off up the filesystem.
 */
export function ancestorDirectories(startDir: string, stopDir: string): string[] {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);

  const relative = path.relative(stop, current);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [];
  }

  const directories: string[] = [];
  for (;;) {
    directories.push(current);
    if (current === stop) {
      return directories;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}

/**
 * The Mill build a notebook belongs to: the nearest directory at or above `startDir`,
 * within `stopDir`, holding one of MILL_ROOT_MARKERS.
 *
 * Shadow scripts have to land inside a Mill build to be compiled at all, and the build
 * isn't always the workspace folder root - a repository may hold the Mill project in a
 * subdirectory, or several Mill projects side by side. Without this, opening the parent
 * of a Mill project wrote the shadow above the build, where Mill never saw it: the
 * notebook was picked up and the shadow written, but no diagnostics ever arrived.
 *
 * Returns undefined when no marker is found, leaving the caller to fall back to the
 * workspace folder root.
 */
export function findMillRoot(
  startDir: string,
  stopDir: string,
  hasMarker: (directory: string, marker: string) => boolean
): string | undefined {
  return ancestorDirectories(startDir, stopDir).find((directory) =>
    MILL_ROOT_MARKERS.some((marker) => hasMarker(directory, marker))
  );
}
