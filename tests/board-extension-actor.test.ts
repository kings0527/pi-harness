import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwd: string;
let originalCwd: string;
let boardTool: any;
let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let board: typeof import("../core/board/index.ts");

function ctx(id?: string): any {
  return {
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/sessions/${id}.jsonl`,
    },
  };
}

before(async () => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "pi-harness-board-actor-test-"));
  process.chdir(cwd);
  handlers = {};
  const extension = (await import(`../extensions/board.ts?actor-test=${Date.now()}`)).default;
  await extension({
    on(name: string, handler: (event: any, context: any) => any) {
      (handlers[name] ??= []).push(handler);
    },
    registerTool(tool: any) { boardTool = tool; },
  });
  board = await import("../core/board/index.ts");
});

after(() => {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
});

async function fire(name: string, event: any, context: any): Promise<void> {
  for (const handler of handlers[name] ?? []) await handler(event, context);
}

test("Board extension rejects unstable writers and persists runtime actor, not caller author", async () => {
  await assert.rejects(
    boardTool.execute("no-session", { action: "open", topic: "actor-topic", goal: "must fail" }, undefined, undefined, ctx(undefined)),
    /stable Pi session actor ID/,
  );
  await boardTool.execute("open", { action: "open", topic: "actor-topic", goal: "actor provenance" }, undefined, undefined, ctx("session-a"));
  await boardTool.execute("post", {
    action: "post", topic: "actor-topic", author: "arbitrary-display-name", content: "claim", kind: "claim", material: true,
  }, undefined, undefined, ctx("session-a"));
  const note = board.readNotes("actor-topic")[0];
  assert.equal(note.author, "arbitrary-display-name");
  assert.equal(note.actor?.id, "session-a");
  assert.equal(note.kind, "claim");
});

test("participation rejects a missing topic and watch/defer require an auditable reason", async () => {
  await assert.rejects(
    boardTool.execute("missing", { action: "participate", topic: "absent", mode: "join" }, undefined, undefined, ctx("session-a")),
    /Open Board topic "absent" not found/,
  );
  await boardTool.execute("open", { action: "open", topic: "participation-topic", goal: "exists" }, undefined, undefined, ctx("session-a"));
  await assert.rejects(
    boardTool.execute("watch", { action: "participate", topic: "participation-topic", mode: "watch" }, undefined, undefined, ctx("session-a")),
    /watch participation requires a reason/,
  );
  await boardTool.execute("watch", { action: "participate", topic: "participation-topic", mode: "watch", reason: "dependency" }, undefined, undefined, ctx("session-a"));
});

test("Fork lineage is recorded only for a real fork session_start", async () => {
  await fire("session_start", { reason: "fork", previousSessionFile: "/sessions/parent.jsonl" }, ctx("session-child"));
  await boardTool.execute("open", { action: "open", topic: "fork-topic", goal: "lineage" }, undefined, undefined, ctx("session-child"));
  assert.equal(board.listOpenTopics().find(topic => topic.id === "fork-topic")?.createdBy?.parentSession, "/sessions/parent.jsonl");

  await fire("session_start", { reason: "resume", previousSessionFile: "/sessions/old.jsonl" }, ctx("session-resume"));
  await boardTool.execute("open", { action: "open", topic: "resume-topic", goal: "not lineage" }, undefined, undefined, ctx("session-resume"));
  assert.equal(board.listOpenTopics().find(topic => topic.id === "resume-topic")?.createdBy?.parentSession, undefined);
});
