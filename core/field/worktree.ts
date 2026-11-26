import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertFieldId, resolveFieldStorageRoot } from "./index.ts";

export interface TentacleWorktree {
  label: string;
  path: string;
  branch: string;
}

export function isGitRepository(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

export function createTentacleWorktree(
  repoCwd: string,
  fieldId: string,
  label: string,
  storageRoot?: string,
): TentacleWorktree {
  assertFieldId(fieldId);
  if (!isGitRepository(repoCwd)) {
    throw new Error(`Worktree mode requires a git repository (cwd: ${repoCwd})`);
  }
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tentacle";
  const baseDir = join(resolveFieldStorageRoot(storageRoot), "worktrees", fieldId);
  mkdirSync(baseDir, { recursive: true });
  const wtPath = join(baseDir, safeLabel);
  const branch = `flux/${fieldId.slice(0, 32)}/${safeLabel}`;

  // Detached HEAD worktree avoids polluting user branches while preserving full
  // git status / diff capability and easy cherry-pick or checkout if winning.
  execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], {
    cwd: repoCwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { label: safeLabel, path: wtPath, branch };
}

export function inspectWorktreeChanges(wtPath: string): { dirty: boolean; summary: string } {
  try {
    const status = execFileSync("git", ["status", "--short"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!status) return { dirty: false, summary: "" };
    const diffStat = execFileSync("git", ["diff", "--stat"], {
      cwd: wtPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const files = status.split("\n").map((l) => l.trim()).join("; ");
    return {
      dirty: true,
      summary: diffStat ? `${files} | ${diffStat.split("\n").at(-1)?.trim() ?? ""}` : files,
    };
  } catch {
    return { dirty: false, summary: "" };
  }
}

export function removeTentacleWorktree(repoCwd: string, wtPath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    if (existsSync(wtPath)) {
      try {
        rmSync(wtPath, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoCwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      /* best effort */
    }
  }
}
