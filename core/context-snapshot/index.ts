import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDir, getStorageRoot } from "../storage/index.ts";

export interface ContextSnapshotFile {
  id: string;
  path: string;
  bytes: number;
}

/** Persist the exact reference message bytes under a content-addressed filename. */
export function writeContextSnapshot(content: string): ContextSnapshotFile {
  const id = createHash("sha256").update(content, "utf-8").digest("hex");
  const directory = join(getStorageRoot(), "context-snapshots");
  const path = join(directory, `${id}.txt`);
  const bytes = Buffer.byteLength(content, "utf-8");
  ensureDir(directory);

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8");
    if (existing !== content) {
      throw new Error(`Context snapshot hash collision at ${path}`);
    }
    return { id, path, bytes };
  }

  const temporaryPath = join(directory, `.${id}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf-8", flag: "wx" });
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      // Another process may have won the same content-addressed write race.
      if (!existsSync(path) || readFileSync(path, "utf-8") !== content) throw error;
    }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }

  return { id, path, bytes };
}
