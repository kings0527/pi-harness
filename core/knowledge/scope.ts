import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/**
 * From filePath walk up toward workspaceRoot, returning the nearest directory
 * that contains a KNOWLEDGE.md, or null if none found before reaching the root.
 */
export function findKnowledgeScope(filePath: string, workspaceRoot: string): string | null {
  let dir = dirname(resolve(filePath));
  const root = resolve(workspaceRoot);
  while (dir.startsWith(root)) {
    if (existsSync(join(dir, "KNOWLEDGE.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Recursively scan workspace for all KNOWLEDGE.md files, skipping SKIP_DIRS,
 * bounded by maxDepth. Returns a Map keyed by directory path.
 */
export function discoverScopes(workspaceRoot: string, maxDepth = 8): Map<string, ScopeEntry> {
  const result = new Map<string, ScopeEntry>();
  const root = resolve(workspaceRoot);

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    const knowledgePath = join(dir, "KNOWLEDGE.md");
    if (existsSync(knowledgePath)) {
      try {
        const stat = statSync(knowledgePath);
        result.set(dir, {
          dir,
          content: readFileSync(knowledgePath, "utf-8").trim(),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Skip unreadable files.
      }
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const child = join(dir, entry);
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1);
      } catch {
        // Skip inaccessible entries.
      }
    }
  }

  walk(root, 0);
  return result;
}

/**
 * Read the KNOWLEDGE.md in a directory. If it exists in the cache with a matching
 * mtime, returns the cached entry. Otherwise re-reads and updates the cache.
 */
export function readScope(dir: string, cache: Map<string, ScopeEntry>): ScopeEntry | null {
  const knowledgePath = join(dir, "KNOWLEDGE.md");
  if (!existsSync(knowledgePath)) return null;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(knowledgePath);
  } catch {
    return null;
  }
  const cached = cache.get(dir);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  try {
    const content = readFileSync(knowledgePath, "utf-8").trim();
    const entry: ScopeEntry = { dir, content, mtimeMs: stat.mtimeMs };
    cache.set(dir, entry);
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
