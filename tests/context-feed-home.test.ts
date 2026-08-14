import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cwd 为 home 的纯聊天首轮保留 global catalog 且不披露子目录正文", async () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-home-chat-test-")));
  const home = join(sandbox, "home");
  const unrelated = join(home, "Documents", "unrelated");
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, "KNOWLEDGE.md"), "HOME-SUBTREE-MARKER\n", "utf-8");

  try {
    process.env.HOME = home;
    process.chdir(home);
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const extension = (await import(`../extensions/context-feed.ts?home-chat=${Date.now()}`)).default;
    await extension({
      on(name: string, handler: (...args: any[]) => any) {
        (handlers[name] ??= []).push(handler);
      },
      appendEntry() {},
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => "home-chat-session",
        buildContextEntries: () => [],
        getBranch: () => [],
      },
      model: { contextWindow: 1_000_000 },
    };

    for (const handler of handlers.session_start ?? []) await handler({}, ctx);
    const results = [];
    for (const handler of handlers.before_agent_start ?? []) {
      results.push(await handler({ prompt: "chat", systemPrompt: "system" }, ctx));
    }
    const reference = results
      .flatMap(result => result?.message ? [result.message] : [])
      .find(message => message.customType === "pi-harness-knowledge-reference");

    assert.ok(reference);
    assert.match(reference.content, /knowledge-catalog:/);
    assert.ok(reference.content.includes(
      `global-index: ${join(home, ".pi-harness", "knowledge", "index.md")}`,
    ));
    assert.doesNotMatch(reference.content, /HOME-SUBTREE-MARKER/);
  } finally {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
