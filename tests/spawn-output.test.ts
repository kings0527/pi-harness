import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let originalCwd: string;
let originalPiBin: string | undefined;
let workDir: string;
let spawnAgent: typeof import("../core/spawn/index.ts").spawnAgent;

before(async () => {
  originalCwd = process.cwd();
  originalPiBin = process.env.PI_BIN;
  workDir = mkdtempSync(join(tmpdir(), "pi-harness-spawn-output-test-"));
  process.chdir(workDir);

  const fakePi = join(workDir, "fake-pi.mjs");
  writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nprocess.stdout.write("BEGIN-" + "x".repeat(9000) + "-END");\n`,
    "utf-8",
  );
  chmodSync(fakePi, 0o755);
  process.env.PI_BIN = fakePi;

  const board = await import("../core/board/index.ts");
  board.openTopic("spawn-full-output", "verify complete child output");
  ({ spawnAgent } = await import("../core/spawn/index.ts"));
});

after(() => {
  process.chdir(originalCwd);
  if (originalPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = originalPiBin;
  rmSync(workDir, { recursive: true, force: true });
});

test("spawnAgent 返回完整 stdout/stderr 而非尾部截取", async () => {
  const result = await spawnAgent({
    profile: {
      name: "test-agent",
      specialty: ["testing"],
      out_of_scope: [],
    },
    topic: "spawn-full-output",
    task: "emit deterministic output",
    cwd: workDir,
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith("BEGIN-"));
  assert.ok(result.output.endsWith("-END"));
  assert.equal(result.output.length, 9010);
});
