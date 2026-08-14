import { lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ScopeEntry {
  dir: string;
  content: string;
  mtimeMs: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".pi-board",
  "dist",
  "build",
  ".next",
  "__pycache__",
  "vendor",
]);

function knowledgeFileStat(dir: string): Stats | null {
  try {
    const stat = lstatSync(join(dir, "KNOWLEDGE.md"));
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function traversesSymlink(root: string, target: string): boolean {
  let current = root;
  const components = relative(root, target).split(sep).filter(Boolean);
  for (const component of ["", ...components]) {
    if (component) current = join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function isSafeScopePath(root: string, target: string): boolean {
  return isWithin(root, target) && !traversesSymlink(root, target);
}

/**
 * From filePath walk up toward workspaceRoot, returning the nearest directory
 * that contains a KNOWLEDGE.md, or null if none found before reaching the root.
 */
export function findKnowledgeScope(filePath: string, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot);
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  let dir = dirname(target);
  if (!isSafeScopePath(root, target) || !isWithin(root, dir)) return null;

  while (true) {
    if (knowledgeFileStat(dir)) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Recursively scan workspace for all KNOWLEDGE.md files, skipping SKIP_DIRS,
 * bounded by maxDepth and maxDirs. Intended for explicit catalog repair, not
 * session startup. Returns a Map keyed by directory path.
 */
export function discoverScopes(
  workspaceRoot: string,
  maxDepth = 8,
  maxDirs = 1000,
): Map<string, ScopeEntry> {
  const result = new Map<string, ScopeEntry>();
  const root = resolve(workspaceRoot);
  let visited = 0;
  let stopped = false;

  // A caller-selected root is trusted as the boundary, but the root itself may
  // not be a symlink. Descendants are inspected as Dirents and symlinks are not
  // followed.
  if (traversesSymlink(root, root)) return result;

  function stopAtBudget(): void {
    if (stopped) return;
    stopped = true;
    console.error(
      `[knowledge/scope] WARN: discoverScopes exceeded ${maxDirs} directories, stopping scan`,
    );
  }

  function walk(dir: string, depth: number): void {
    if (stopped || depth > maxDepth) return;
    if (visited >= maxDirs) {
      stopAtBudget();
      return;
    }
    visited += 1;

    const stat = knowledgeFileStat(dir);
    if (stat) {
      try {
        result.set(dir, {
          dir,
          content: readFileSync(join(dir, "KNOWLEDGE.md"), "utf-8").trim(),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files.
      }
    }
    if (depth === maxDepth) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped) break;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
    }
  }

  walk(root, 0);
  return result;
}

/**
 * Read the KNOWLEDGE.md in a directory. If it exists in the cache with a matching
 * mtime, returns the cached entry. Otherwise re-reads and updates the cache.
 */
export function readScope(
  dir: string,
  cache: Map<string, ScopeEntry>,
  scopeRoot: string = dir,
): ScopeEntry | null {
  const normalizedDir = resolve(dir);
  const root = resolve(scopeRoot);
  if (!isSafeScopePath(root, normalizedDir)) return null;

  const knowledgePath = join(normalizedDir, "KNOWLEDGE.md");
  const stat = knowledgeFileStat(normalizedDir);
  if (!stat) return null;
  const cached = cache.get(normalizedDir);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  try {
    const content = readFileSync(knowledgePath, "utf-8").trim();
    const entry: ScopeEntry = { dir: normalizedDir, content, mtimeMs: stat.mtimeMs };
    cache.set(normalizedDir, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Extract ## Always and ## Areas sections from a root KNOWLEDGE.md content.
 * Returns the extracted sections and the remaining text.
 */
export function extractRootSections(content: string): { always: string; areas: string; rest: string } {
  const lines = content.split("\n");
  let always = "";
  let areas = "";
  const restLines: string[] = [];
  let current: "always" | "areas" | "rest" = "rest";

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      if (title === "always") {
        current = "always";
        continue;
      } else if (title === "areas") {
        current = "areas";
        continue;
      } else {
        current = "rest";
      }
    }
    if (current === "always") always += (always ? "\n" : "") + line;
    else if (current === "areas") areas += (areas ? "\n" : "") + line;
    else restLines.push(line);
  }

  return { always: always.trim(), areas: areas.trim(), rest: restLines.join("\n").trim() };
}
