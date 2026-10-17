import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scopedProjectRoot } from "../runtime/root.ts";

let storageRoot: string | null = null;

export function getStorageRoot(): string {
  // A hosting runtime can pin the project root for one operation. The pinned
  // path is not memoized (one process may serve many projects); pi's default
  // path keeps its original memoization and cwd anchor byte-for-byte.
  const scoped = scopedProjectRoot();
  if (scoped) {
    const root = join(scoped, ".pi-board");
    ensureDir(root);
    ensureDir(join(root, "topics"));
    ensureDir(join(root, "topics", "archive"));
    return root;
  }
  if (storageRoot) return storageRoot;
  // 项目本地存储
  storageRoot = join(process.cwd(), ".pi-board");
  ensureDir(storageRoot);
  ensureDir(join(storageRoot, "topics"));
  ensureDir(join(storageRoot, "topics", "archive"));
  return storageRoot;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
