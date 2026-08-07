// ADR-0009: fingerprint tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint } from "../core/anti-drift/fingerprint.ts";

test("read: same path, same range → same fingerprint", () => {
  const a = fingerprint({ tool: "read", input: { file_path: "/tmp/x.ts" } });
  const b = fingerprint({ tool: "read", input: { file_path: "/tmp/x.ts" } });
  assert.equal(a, b);
});

test("read: relative vs absolute → same fingerprint after resolve()", () => {
  const a = fingerprint({ tool: "read", input: { file_path: "tmp/x.ts" } });
  const b = fingerprint({ tool: "read", input: { file_path: "./tmp/x.ts" } });
  assert.equal(a, b);
});

test("read: different ranges → different fingerprints", () => {
  const a = fingerprint({ tool: "read", input: { file_path: "x.ts", offset: 0, limit: 100 } });
  const b = fingerprint({ tool: "read", input: { file_path: "x.ts", offset: 100, limit: 100 } });
  assert.notEqual(a, b);
});

test("read: different paths → different fingerprints", () => {
  const a = fingerprint({ tool: "read", input: { file_path: "a.ts" } });
  const b = fingerprint({ tool: "read", input: { file_path: "b.ts" } });
  assert.notEqual(a, b);
});

test("bash: hex addresses normalize to 0xADDR", () => {
  const a = fingerprint({ tool: "bash", input: { command: "objdump -d 0x1000" } });
  const b = fingerprint({ tool: "bash", input: { command: "objdump -d 0x2000" } });
  assert.equal(a, b, "different addresses with same verb should match");
});

test("bash: different commands → different fingerprints", () => {
  const a = fingerprint({ tool: "bash", input: { command: "ls -la" } });
  const b = fingerprint({ tool: "bash", input: { command: "ls -laR" } });
  assert.notEqual(a, b);
});

test("bash: long commands truncate to 80 chars", () => {
  const longA = "a".repeat(200);
  const longB = "a".repeat(200) + "X";
  const a = fingerprint({ tool: "bash", input: { command: longA } });
  const b = fingerprint({ tool: "bash", input: { command: longB } });
  assert.equal(a, b, "truncation makes them equal");
});

test("bash: large numeric IDs collapse to N", () => {
  const a = fingerprint({ tool: "bash", input: { command: "kill 12345" } });
  const b = fingerprint({ tool: "bash", input: { command: "kill 67890" } });
  assert.equal(a, b);
});

test("grep: same query+path → same fingerprint; different query → different", () => {
  const a = fingerprint({ tool: "grep", input: { query: "TODO", path: "src" } });
  const b = fingerprint({ tool: "grep", input: { query: "TODO", path: "src" } });
  assert.equal(a, b);
  const c = fingerprint({ tool: "grep", input: { query: "FIXME", path: "src" } });
  assert.notEqual(a, c);
});

test("edit/write: same path → same fingerprint", () => {
  const a = fingerprint({ tool: "edit", input: { file_path: "a.ts", newText: "x" } });
  const b = fingerprint({ tool: "edit", input: { file_path: "a.ts", newText: "y" } });
  // edit intentional: we want to detect "edit same file repeatedly" even if content differs
  assert.equal(a, b);
});

test("unknown tool: stable across identical inputs, distinct across distinct", () => {
  const a = fingerprint({ tool: "mystery", input: { x: "1", y: "2" } });
  const b = fingerprint({ tool: "mystery", input: { x: "1", y: "2" } });
  assert.equal(a, b);
  const c = fingerprint({ tool: "mystery", input: { x: "1", y: "3" } });
  assert.notEqual(a, c);
});

test("missing input does not throw and produces a stable fingerprint", () => {
  const a = fingerprint({ tool: "read", input: undefined });
  const b = fingerprint({ tool: "read", input: undefined });
  assert.equal(a, b);
  assert.match(a, /^read\|/);
});
