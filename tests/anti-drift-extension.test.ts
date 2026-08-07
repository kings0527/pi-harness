// ADR-0009 (revised): extension integration tests.
// New contract:
// - tool_call with same fingerprint as the immediately previous call → warn event
// - tool_call with a different fingerprint → no warn
// - PI_ANTIDRIFT_DISABLED=1 → completely silent, no state file, no event
// - sessionId with path-traversal chars is sanitized
// - No context injection. No mode switching. No NEUTRAL counting.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string;
let handlers: Record<string, Function[]>;

async function fireAsync(event: string, payload: any) {
  for (const h of handlers[event] ?? []) {
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
  delete process.env.PI_ANTIDRIFT_DISABLED;
});

test("tool_call creates state file with the fingerprint recorded", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  const sf = stateFile(sid);
  assert.ok(existsSync(sf), `state file should exist at ${sf}`);
  const data = JSON.parse(readFileSync(sf, "utf-8"));
  assert.equal(data.recent.length, 1);
  assert.equal(data.recent[0].startsWith("read|"), true);
});

test("two identical tool calls in a row trigger exactly one warn event", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  const events = readEvents().filter(e => e.details.session === sid);
  const warns = events.filter((e: any) => e.type === "hook_warn" && e.details.rule === "anti-drift-repeat-action");
  assert.equal(warns.length, 1, "exactly one repeat-action warn");
  assert.match(warns[0].details.message as string, /Same action as previous turn/);
});

test("three identical calls produce exactly two warns (one per repeat)", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "x.ts" } });
  const events = readEvents().filter(e => e.details.session === sid);
  const warns = events.filter((e: any) => e.type === "hook_warn");
  assert.equal(warns.length, 2, "each repeat after the first produces a warn");
});

test("A,B,A pattern: only A,B then B,A produce warns; A,B,A is intentional, not warned", async () => {
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "b.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  const events = readEvents().filter(e => e.details.session === sid);
  const warns = events.filter((e: any) => e.type === "hook_warn");
  // First call has no previous → no warn.
  // A→B: different → no warn.
  // B→A: different → no warn.
  assert.equal(warns.length, 0, "A,B,A is intentional oscillation, not warned");
});

test("PI_ANTIDRIFT_DISABLED=1: completely silent", async () => {
  process.env.PI_ANTIDRIFT_DISABLED = "1";
  const sid = newSession();
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  assert.equal(existsSync(stateFile(sid)), false, "no state file when disabled");
  const events = readEvents().filter(e => e.details.session === sid);
  assert.equal(events.length, 0, "no events when disabled");
  delete process.env.PI_ANTIDRIFT_DISABLED;
});

test("sessionId with path-traversal chars is sanitized", async () => {
  process.env.PI_SESSION_ID = "../../etc/passwd";
  await fireAsync("tool_call", { tool: "read", input: { file_path: "a.ts" } });
  const stateDir = join(workDir, ".pi-board", "anti-drift");
  const files = readdirSync(stateDir);
  // The sanitized id should produce a filename with NO ".." or "/"
  const sanitizedFile = files.find(f => !f.startsWith("test-"));
  assert.ok(sanitizedFile, "a sanitized state file was created");
  assert.equal(sanitizedFile.includes(".."), false, `file contains "..": ${sanitizedFile}`);
  assert.equal(sanitizedFile.includes("/"), false, `file contains "/": ${sanitizedFile}`);
  // Original unsafe id is not used as filename
  assert.equal(existsSync(stateFile("../../etc/passwd")), false);
  // Critical: the file lives inside the state dir, not outside it
  const fullPath = join(stateDir, sanitizedFile);
  assert.ok(fullPath.startsWith(stateDir), `file ${fullPath} escapes state dir ${stateDir}`);
});

test("context hook is NOT registered (we don't pollute model context)", async () => {
  const ctx = handlers["context"] ?? [];
  assert.equal(ctx.length, 0, "context handler intentionally absent");
});

test("after_agent hook is NOT registered (no mode to exit)", async () => {
  const ag = handlers["after_agent"] ?? [];
  assert.equal(ag.length, 0, "after_agent handler intentionally absent");
});

test("tool_result hook is NOT registered (no evidence classification)", async () => {
  const tr = handlers["tool_result"] ?? [];
  assert.equal(tr.length, 0, "tool_result handler intentionally absent");
});

test("session_start hook is NOT registered (we don't need warm-up)", async () => {
  const ss = handlers["session_start"] ?? [];
  assert.equal(ss.length, 0, "session_start handler intentionally absent");
});

test("only tool_call is registered — minimal surface", async () => {
  assert.equal((handlers["tool_call"] ?? []).length, 1, "exactly one tool_call handler");
});
