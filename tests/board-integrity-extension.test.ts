// ADR-0020: board-integrity extension integration tests (real temp Git repo).
// Contract:
// - .pi-board tracked by Git → session_start warns (stderr + events.jsonl)
// - clean repo (no .pi-board in index) → no warn, no event
// - same session, repeated session_start → exactly one warn
// - new session (PI_SESSION_ID change) re-checks the repo
// - not a git repo → silent
// - PI_BOARD_INTEGRITY_DISABLED=1 → silent, no event

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let originalCwd: string;
let handlers: Record<string, Function[]>;
let stderrLines: string[];

async function fireAsync(event: string, payload: any, ctx: any = {}) {
  for (const h of handlers[event] ?? []) {
    await Promise.resolve(h(payload, ctx));
  }
}

/** Real-shaped ctx: sessions come from sessionManager, cwd from ctx.cwd. */
function makeCtx(sessionId: string, cwd: string = workDir): any {
  return { sessionManager: { getSessionId: () => sessionId }, cwd };
}

function eventsFile(): string {
  return join(workDir, ".pi-board", "events.jsonl");
}

function readEvents(): any[] {
  const p = eventsFile();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function gitWarns(): any[] {
  return readEvents().filter(
    e => e.type === "hook_warn" && e.details.rule === "board-git-tracking",
  );
}

function git(args: string[]): void {
  const result = spawnSync("git", args, { cwd: workDir, encoding: "utf-8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

before(async () => {
  originalCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-board-integrity-ext-test-"));
  process.chdir(workDir);
  mkdirSync(join(workDir, ".pi-board"), { recursive: true });
  writeFileSync(eventsFile(), "", "utf-8");
  handlers = {};
  stderrLines = [];
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map(a => String(a)).join(" "));
  };
  const fakePi = {
    on(event: string, fn: Function) {
      (handlers[event] ??= []).push(fn);
    },
    registerTool() {},
  };
  const registerExtension = (await import("../extensions/board-integrity.ts")).default;
  await registerExtension(fakePi);
});

after(() => {
  console.error = console.error.bind(console);
  process.chdir(originalCwd);
  delete process.env.PI_SESSION_ID;
  delete process.env.PI_BOARD_INTEGRITY_DISABLED;
  rmSync(workDir, { recursive: true, force: true });
});

test("tracked .pi-board → session_start 告警一次（stderr + event）", async () => {
  git(["init", "-q"]);
  git(["add", ".pi-board/events.jsonl"]);

  // PI_SESSION_ID is NOT the extension contract: the id must come from ctx.
  delete process.env.PI_SESSION_ID;
  await fireAsync("session_start", {}, makeCtx("s-tracked"));
  await fireAsync("session_start", {}, makeCtx("s-tracked"));
  await fireAsync("session_start", {}, makeCtx("s-tracked"));

  const warns = gitWarns();
  assert.equal(warns.length, 1, "same session warns exactly once");
  assert.equal(warns[0].details.session, "s-tracked");
  assert.match(warns[0].details.message as string, /tracked by Git/);
  assert.match(
    warns[0].details.message as string,
    /git rm -r --cached \.pi-board/,
    "remediation must remove the file from the index, not just .gitignore",
  );
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /board-integrity/);
});

test("不同 session 各自检查：s1/s2 均告警一次，同 session 不重复", async () => {
  // The repo stays TRACKED the whole time — this proves the per-session
  // dedup key really drives the check, not a lucky git state mutation.
  await fireAsync("session_start", {}, makeCtx("s-two-sessions-1"));
  await fireAsync("session_start", {}, makeCtx("s-two-sessions-2"));
  await fireAsync("session_start", {}, makeCtx("s-two-sessions-2")); // dup: silent

  const warns = gitWarns();
  const own = warns.filter(w => String(w.details.session).startsWith("s-two-sessions"));
  assert.equal(own.length, 2, "one warning per distinct session");
  assert.deepEqual(
    own.map(w => w.details.session).sort(),
    ["s-two-sessions-1", "s-two-sessions-2"],
  );
  assert.equal(stderrLines.length, 3);
});

test("修复后（index 干净）新 session 不再告警", async () => {
  git(["rm", "-r", "--cached", "-f", "-q", ".pi-board"]);
  await fireAsync("session_start", {}, makeCtx("s-clean-after-fix"));
  await fireAsync("session_start", {}, makeCtx("s-clean-after-fix"));

  assert.equal(gitWarns().length, 3, "clean index adds no new warnings");
  assert.equal(stderrLines.length, 3);
});

test("未跟踪（干净 index）的仓不告警", async () => {
  // events.jsonl was already removed from the index by the previous test.
  await fireAsync("session_start", {}, makeCtx("s-clean-repo"));
  await fireAsync("session_start", {}, makeCtx("s-clean-repo"));

  assert.equal(gitWarns().length, 3);
  assert.equal(stderrLines.length, 3);
});

test("非 git 仓静默（ctx.cwd 优先于 process.cwd）", async () => {
  const plainDir = mkdtempSync(join(tmpdir(), "pi-harness-board-integrity-nogit-"));
  try {
    await fireAsync("session_start", {}, makeCtx("s-not-a-repo", plainDir));
    assert.equal(gitWarns().length, 3, "no new warns outside a repo");
    assert.equal(stderrLines.length, 3);
  } finally {
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("P2 回归：.pi-board 目录已删但仍在 index — 告警且事件落盘重建目录", async () => {
  git(["add", "-f", ".pi-board/events.jsonl"]);
  rmSync(join(workDir, ".pi-board"), { recursive: true, force: true });
  try {
    await fireAsync("session_start", {}, makeCtx("s-missing-dir"));
    // No crash; the evidence append recreated the directory.
    const warns = gitWarns();
    assert.equal(warns.filter(w => w.details.session === "s-missing-dir").length, 1);
    assert.ok(existsSync(eventsFile()), "events.jsonl recreated in the inspected repo");
  } finally {
    git(["rm", "-r", "--cached", "-f", "-q", ".pi-board"]);
    // Keep accumulated evidence; only recreate the directory, not the file.
    mkdirSync(join(workDir, ".pi-board"), { recursive: true });
  }
});

test("PI_BOARD_INTEGRITY_DISABLED=1 完全静默", async () => {
  process.env.PI_BOARD_INTEGRITY_DISABLED = "1";
  git(["add", "-f", ".pi-board/events.jsonl"]);
  try {
    await fireAsync("session_start", {}, makeCtx("s-disabled"));
    // The .pi-board wipe in the previous test reset the on-disk events to
    // just the s-missing-dir warning; the in-process stderr tally is intact.
    assert.equal(gitWarns().length, 1, "disabled hook emits nothing new");
    assert.equal(stderrLines.length, 4);
  } finally {
    git(["rm", "-r", "--cached", "-f", "-q", ".pi-board"]);
    delete process.env.PI_BOARD_INTEGRITY_DISABLED;
  }
});
