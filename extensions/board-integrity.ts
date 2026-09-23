// ADR-0020: Board integrity runtime hook — Git-tracking warning ONLY.
//
// Why: a sibling project's .pi-board/ was tracked by Git; a conflict merge rolled back a
// closed topic's archive JSONL (notes #31–#35 lost; only summary/decisions
// survived). Append-only files assume one writer per file; Git last-write-wins
// silently violates that invariant across machines.
//
// What this hook does (and does not):
// - On session_start, run `git ls-files .pi-board` once. If any path is
//   tracked, emit ONE operator-visible warning (stderr + events.jsonl).
// - It never injects into the model context (same policy as anti-drift),
//   never mutates user files (adding .gitignore entries is the operator's
//   call), and never blocks tool calls.
// - Core already fails loud on seq gaps/rollbacks (ADR-0020); this hook
//   catches the upstream cause — Git tracking — before a rollback lands.
//   Disable with PI_BOARD_INTEGRITY_DISABLED=1.

import { spawnSync } from "node:child_process";
import { appendEvent } from "../core/events/index.ts";
import { boardTrackedPaths } from "../core/board/git-tracking.ts";

// Dedup per session, NOT per process: Pi is a long-lived process and may
// host many sessions. A fresh session re-checks; a clean result (or a
// warning already emitted for that session) is remembered so repeated
// session_start events stay silent. A git failure is never remembered, so
// a later session retries instead of being skipped forever.
const cleanOrWarnedSessions = new Set<string>();

function getSessionId(ctx: any): string {
  // PI_SESSION_ID is injected into Bash child processes, NOT into the
  // extension process env. The authoritative session id comes from ctx;
  // sessions without a manager get a per-process fallback.
  return (
    ctx?.sessionManager?.getSessionId?.() ??
    `pid-${process.pid}`
  );
}

function gitLsBoardFiles(cwd: string): { inRepo: boolean; tracked: string[]; gitMissing?: boolean } {
  // Not a repo / git missing / error → nothing to warn about. The Board
  // store only faces last-write-wins rollback inside a Git worktree.
  const result = spawnSync("git", ["ls-files", "--", ".pi-board"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error) {
    return { inRepo: false, tracked: [], gitMissing: (result.error as NodeJS.ErrnoException)?.code === "ENOENT" };
  }
  if (result.status !== 0) return { inRepo: false, tracked: [] };
  return { inRepo: true, tracked: boardTrackedPaths(result.stdout) };
}

export default async function (pi: any) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    // Check inside the handler too: the flag may be set after registration.
    if (process.env.PI_BOARD_INTEGRITY_DISABLED === "1") return;
    const sessionId = getSessionId(ctx);
    if (cleanOrWarnedSessions.has(sessionId)) return;

    const cwd = ctx?.cwd || process.cwd();
    const { inRepo, tracked, gitMissing } = gitLsBoardFiles(cwd);
    if (!inRepo) {
      // Only git itself being absent is definitive: no repo can ever appear
      // under this session without re-running the hook. Transient failures
      // (timeout, locked index) stay unremembered and retry next session.
      if (gitMissing) cleanOrWarnedSessions.add(sessionId);
      return;
    }

    if (tracked.length > 0) {
      const message =
        `[board-integrity] .pi-board/ is tracked by Git (${tracked.length} file${tracked.length === 1 ? "" : "s"}). ` +
        `Board JSONL is append-only; Git last-write-wins can roll back closed topics on conflict. ` +
        `Remove it from the index, then ignore it:\n` +
        `  git rm -r --cached .pi-board && printf '\n.pi-board/\n' >> .gitignore`;
      console.error(message);
      // The evidence must land in the repo that was inspected (ctx.cwd),
      // not in the extension process's own cwd anchor. A failed append must
      // not crash the session or repeat the warning every session.
      try {
        appendEvent(
          "hook_warn",
          {
            rule: "board-git-tracking",
            session: sessionId,
            message,
            trackedCount: tracked.length,
            trackedSample: tracked.slice(0, 10),
          },
          cwd,
        );
      } catch (error: any) {
        console.error(`[board-integrity] event append failed: ${error?.message ?? error}`);
      }
    }
    // Remember only decisive outcomes (clean repo or warning already sent).
    cleanOrWarnedSessions.add(sessionId);
  });
}
