// ADR-0020: detect whether the Board runtime store is tracked by Git.
// Pure parsing of `git ls-files` output — no child processes in core
// (runtime-agnostic boundary: extensions own the git spawn).

/**
 * Paths under .pi-board that Git tracks, from `git ls-files -- .pi-board`
 * output. Empty array means the Board store is clean (or not in a repo).
 */
export function boardTrackedPaths(lsFilesOutput: string): string[] {
  return lsFilesOutput
    .split("\n")
    .map(line => line.trim())
    .filter(line => line === ".pi-board" || line.startsWith(".pi-board/"));
}
