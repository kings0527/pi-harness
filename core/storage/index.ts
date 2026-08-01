import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let storageRoot: string | null = null;

export function getStorageRoot(): string {
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
