// ADR-0009: extension integration tests.
// Each test uses a unique PI_SESSION_ID to isolate state. Module is loaded once
// (extension registers handlers once); each handler reads state per-call from disk.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let handlers: Record<string, Function[]>;

function fire(event: string, payload: any) {
  for (const h of handlers[event] ?? []) {
    // Each handler is async; await via Promise.resolve so errors surface in tests.
    return Promise.resolve(h(payload, {})).then(() => undefined);
  }
}

async function fireAsync(event: string, payload: any) {
  const list = handlers[event] ?? [];
  for (const h of list) {
    await Promise.resolve(h(payload, {}));
  }
}

function eventsFile(): string {
  return join(workDir, ".pi-board", "events.jsonl");
}

function stateFile(sessionId: string): string {
  return join(workDir, ".pi-board", "anti-drift", `${sessionId}.json`);
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

function readState(sessionId: string): any {
  return JSON.parse(readFileSync(stateFile(sessionId), "utf-8"));
}

let nextSession = 0;
function newSession(): string {
  nextSession += 1;
  process.env.PI_SESSION_ID = `test-${nextSession}-${Date.now()}`;
  return process.env.PI_SESSION_ID;
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-anti-drift-test-"));
  process.chdir(workDir);
  handlers = {};
  const fakePi = {
    on(event: string, fn: Function) {
      (handlers[event] ??= []).push(fn);
    },
    registerTool() {},
  };
  const registerExtension = (await import("../extensions/anti-drift.ts")).default;
  await registerExtension(fakePi);
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.PI_SESSION_ID;
});

test("tool_call creates state file and records fingerprint", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  const sf = stateFile(sid);
  assert.ok(existsSync(sf), `state file should exist at ${sf}`);
  const s = readState(sid);
  assert.equal(s.sessionId, sid);
  assert.equal(s.mode, "MONITOR");
  assert.equal(s.recentFingerprints.length, 1);
  assert.equal(s.recentFingerprints[0].startsWith("read|"), true);
});

test("equivalent actions (same read twice) trigger a hook_warn event", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  const events = readEvents().filter(e => e.details.session === sid);
  const warns = events.filter((e: any) => e.type === "hook_warn" && e.details.rule === "anti-drift-equivalent-action");
  assert.equal(warns.length, 1, "exactly one equivalent-action warn");
  assert.match(warns[0].details.message as string, /Equivalent action detected/);
});

test("non-equivalent actions do NOT trigger the equivalent-action warn", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "b.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "c.ts" } });
  const events = readEvents().filter(e => e.details.session === sid);
  const equiv = events.filter((e: any) => e.details.rule === "anti-drift-equivalent-action");
  assert.equal(equiv.length, 0);
});

test("3 consecutive NEUTRAL inspection results escalate to STRICT", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "content-1" });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "b.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "content-2" });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "c.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "content-3" });
  const s = readState(sid);
  assert.equal(s.mode, "STRICT");
  assert.equal(s.neutralStreak, 3);
  // And a warn event was emitted
  const events = readEvents().filter(e => e.details.session === sid);
  const strictWarns = events.filter((e: any) => e.type === "hook_warn" && e.details.rule === "anti-drift-stall-strict");
  assert.equal(strictWarns.length, 1);
});

test("side-effect (edit) resets the neutral streak", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "x" });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "b.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "x" });
  await fireAsync("tool_call", { tool: "edit", input: { file_path: "a.ts" } });
  await fireAsync("tool_result", { tool: "edit", output: "ok" });
  const s = readState(sid);
  assert.equal(s.neutralStreak, 0);
});

test("context hook injects compact state into the last user message", async () => {
  newSession(); // fresh session
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  const messages = [
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "ok" },
  ];
  const ctxHandlers = handlers["context"] ?? [];
  assert.ok(ctxHandlers.length > 0, "context handler registered");
  await Promise.resolve(ctxHandlers[0]({ messages }, {}));
  const text = messages[0].content as string;
  assert.match(text, /<!-- anti-drift: mode=MONITOR/);
  // size cap: with path truncation, well under 200 bytes added even with absolute paths.
  const delta = text.length - "do the thing".length;
  assert.ok(delta < 200, `delta too large: ${delta} bytes`);
});

test("after_agent exits STRICT back to MONITOR", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "x" });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "b.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "x" });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "c.ts" } });
  await fireAsync("tool_result", { tool: "read", output: "x" });
  let s = readState(sid);
  assert.equal(s.mode, "STRICT");
  await fireAsync("after_agent", {});
  s = readState(sid);
  assert.equal(s.mode, "MONITOR");
});
