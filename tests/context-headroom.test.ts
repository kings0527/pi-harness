import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessContextHeadroom,
  clampProviderOutputBudget,
} from "../core/context-headroom/index.ts";

const WINDOW = 1_048_576;
const originalCwd = process.cwd();
let sandbox = "";

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pi-harness-context-headroom-test-"));
  process.chdir(sandbox);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

test("headroom 同时预留 48K completion 和单轮 ingress", () => {
  const below = assessContextHeadroom({
    contextTokens: 960_000,
    contextWindow: WINDOW,
    modelMaxOutputTokens: 48_000,
  });
  assert.equal(below.outputReserveTokens, 48_000);
  assert.equal(below.ingressReserveTokens, 32_768);
  assert.equal(below.thresholdTokens, 967_808);
  assert.equal(below.shouldCompact, false);

  const above = assessContextHeadroom({
    contextTokens: 980_000,
    contextWindow: WINDOW,
    modelMaxOutputTokens: 48_000,
  });
  assert.equal(above.shouldCompact, true);
});

test("过大 model maxTokens 不会导致在半窗口就压缩", () => {
  const assessment = assessContextHeadroom({
    contextTokens: 900_000,
    contextWindow: 1_000_000,
    modelMaxOutputTokens: 1_000_000,
  });
  assert.equal(assessment.outputReserveTokens, 48_000);
  assert.equal(assessment.shouldCompact, false);
});

test("小窗口 ingress reserve 按比例缩放，不在半窗口提前压缩", () => {
  const assessment = assessContextHeadroom({
    contextTokens: 4_096,
    contextWindow: 8_192,
    modelMaxOutputTokens: 2_048,
  });
  assert.equal(assessment.outputReserveTokens, 2_048);
  assert.equal(assessment.ingressReserveTokens, 328);
  assert.equal(assessment.thresholdTokens, 5_816);
  assert.equal(assessment.shouldCompact, false);
});

test("provider 实际观测额度高于 48K 时扩大后续 completion reserve", () => {
  const assessment = assessContextHeadroom({
    contextTokens: 850_000,
    contextWindow: 1_000_000,
    modelMaxOutputTokens: 1_000_000,
    observedMaxOutputTokens: 128_000,
  });
  assert.equal(assessment.outputReserveTokens, 128_000);
  assert.equal(assessment.shouldCompact, true);
});

test("大的当前输入会扩大 ingress reserve", () => {
  const assessment = assessContextHeadroom({
    contextTokens: 960_000,
    contextWindow: WINDOW,
    modelMaxOutputTokens: 48_000,
    pendingInputTokens: 50_000,
  });
  assert.equal(assessment.ingressReserveTokens, 82_768);
  assert.equal(assessment.thresholdTokens, 917_808);
  assert.equal(assessment.shouldCompact, true);
});

test("provider last-mile 只收紧 output budget，保留原 payload 其他字段", () => {
  const payload = {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read" } }],
    max_tokens: 48_000,
    temperature: 0.2,
  };
  const result = clampProviderOutputBudget(payload, {
    contextTokens: 1_001_471,
    contextWindow: WINDOW,
  });
  assert.equal(result.changed, true);
  assert.equal(result.field, "max_tokens");
  assert.equal(result.requestedTokens, 48_000);
  assert.equal(result.allowedTokens, 30_721);
  assert.deepEqual(result.payload, { ...payload, max_tokens: 30_721 });
  assert.equal(payload.max_tokens, 48_000, "input payload is not mutated");
});

test("provider last-mile 在空间充足或无识别字段时不改 payload", () => {
  assert.equal(clampProviderOutputBudget(
    { max_completion_tokens: 48_000 },
    { contextTokens: 900_000, contextWindow: WINDOW },
  ).changed, false);
  assert.equal(clampProviderOutputBudget(
    { temperature: 0.2 },
    { contextTokens: 1_001_471, contextWindow: WINDOW },
  ).changed, false);
});

test("provider last-mile 覆盖 Google、Bedrock、Mistral 字段且只克隆目标路径", () => {
  const google = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    config: { maxOutputTokens: 48_000, temperature: 0.2 },
  };
  const googleResult = clampProviderOutputBudget(google, {
    contextTokens: 1_001_471,
    contextWindow: WINDOW,
  });
  assert.equal(googleResult.field, "config.maxOutputTokens");
  assert.equal((googleResult.payload as any).config.maxOutputTokens, 30_721);
  assert.equal(google.config.maxOutputTokens, 48_000);
  assert.equal((googleResult.payload as any).contents, google.contents);

  const bedrockResult = clampProviderOutputBudget(
    { inferenceConfig: { maxTokens: 48_000 }, messages: [] },
    { contextTokens: 1_001_471, contextWindow: WINDOW },
  );
  assert.equal(bedrockResult.field, "inferenceConfig.maxTokens");
  assert.equal((bedrockResult.payload as any).inferenceConfig.maxTokens, 30_721);

  const mistralResult = clampProviderOutputBudget(
    { maxTokens: 48_000, messages: [] },
    { contextTokens: 1_001_471, contextWindow: WINDOW },
  );
  assert.equal(mistralResult.field, "maxTokens");
  assert.equal((mistralResult.payload as any).maxTokens, 30_721);

  const piMessagesResult = clampProviderOutputBudget(
    { options: { maxTokens: 48_000, reasoning: "high" }, context: {} },
    { contextTokens: 1_001_471, contextWindow: WINDOW },
  );
  assert.equal(piMessagesResult.field, "options.maxTokens");
  assert.equal((piMessagesResult.payload as any).options.maxTokens, 30_721);
});

test("provider last-mile 按小窗口缩放 safety，不把充足 output 压成 1 token", () => {
  for (const fixture of [
    { contextWindow: 4_095, contextTokens: 409, max_tokens: 1_024 },
    { contextWindow: 8_192, contextTokens: 819, max_tokens: 2_048 },
    { contextWindow: 16_384, contextTokens: 1_638, max_tokens: 4_096 },
  ]) {
    const payload = { max_tokens: fixture.max_tokens };
    const result = clampProviderOutputBudget(payload, fixture);
    assert.equal(result.changed, false, `window=${fixture.contextWindow}`);
    assert.equal(result.payload, payload);
  }
});

test("Anthropic thinking budget 随 max_tokens 联动收紧且不改原 payload", () => {
  const payload = {
    max_tokens: 48_000,
    thinking: { type: "enabled", budget_tokens: 40_000 },
    messages: [],
  };
  const result = clampProviderOutputBudget(payload, {
    contextTokens: 1_001_471,
    contextWindow: WINDOW,
  });
  assert.equal(result.changed, true);
  assert.equal((result.payload as any).max_tokens, 30_721);
  assert.equal((result.payload as any).thinking.budget_tokens, 29_697);
  assert.equal(payload.max_tokens, 48_000);
  assert.equal(payload.thinking.budget_tokens, 40_000);
});

test("Bedrock thinking budget 随 inferenceConfig.maxTokens 联动收紧", () => {
  const payload = {
    inferenceConfig: { maxTokens: 48_000 },
    additionalModelRequestFields: {
      thinking: { type: "enabled", budget_tokens: 40_000 },
    },
  };
  const result = clampProviderOutputBudget(payload, {
    contextTokens: 1_001_471,
    contextWindow: WINDOW,
  });
  assert.equal((result.payload as any).inferenceConfig.maxTokens, 30_721);
  assert.equal(
    (result.payload as any).additionalModelRequestFields.thinking.budget_tokens,
    29_697,
  );
  assert.equal(payload.additionalModelRequestFields.thinking.budget_tokens, 40_000);
});

test("OpenAI Responses output clamp 保持 provider 最低 16 tokens", () => {
  const result = clampProviderOutputBudget(
    { max_output_tokens: 48_000, input: [] },
    { contextTokens: WINDOW - 5, contextWindow: WINDOW },
  );
  assert.equal(result.changed, true);
  assert.equal(result.allowedTokens, 16);
  assert.equal((result.payload as any).max_output_tokens, 16);
});

interface Harness {
  handlers: Record<string, Array<(...args: any[]) => any>>;
  sent: any[];
  entries: Array<{ type: string; data: any }>;
}

async function registerExtension(): Promise<Harness> {
  const handlers: Harness["handlers"] = {};
  const sent: any[] = [];
  const entries: Harness["entries"] = [];
  const extension = (await import(`../extensions/context-headroom.ts?test=${Math.random()}`)).default;
  await extension({
    on(name: string, handler: (...args: any[]) => any) {
      (handlers[name] ??= []).push(handler);
    },
    sendUserMessage(content: any, options?: { deliverAs?: "steer" | "followUp" }) {
      sent.push(options ? { content, options } : content);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
  });
  return { handlers, sent, entries };
}

function runtimeContext(tokens: number | null, overrides: Record<string, unknown> = {}): any {
  return {
    sessionManager: { getSessionId: () => "headroom-session" },
    model: { id: "test-model", contextWindow: WINDOW, maxTokens: 48_000 },
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens === null ? null : tokens / WINDOW * 100 }),
    isIdle: () => true,
    compact() {},
    ...overrides,
  };
}

async function fire(harness: Harness, name: string, event: any, ctx: any): Promise<any[]> {
  const results = [];
  for (const handler of harness.handlers[name] ?? []) results.push(await handler(event, ctx));
  return results;
}

test("session_start 生命周期边界等待 proactive compaction 结算后才返回", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });

  let startResolved = false;
  const starting = fire(harness, "session_start", { reason: "resume" }, ctx).then(result => {
    startResolved = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(compactCalls.length, 1);
  assert.equal(startResolved, false);

  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  assert.deepEqual(await starting, [undefined]);
  assert.equal(startResolved, true);
  assert.equal(compactCalls.length, 1);
  assert.deepEqual(harness.sent, []);
});

test("session shutdown 先清理时也会结算正在 await 的 proactive barrier", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(980_000, {
    compact: (options: any) => compactCalls.push(options),
  });
  let lifecycleSettled = false;
  const settled = fire(harness, "agent_settled", {}, ctx).then(result => {
    lifecycleSettled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lifecycleSettled, false);
  assert.equal(compactCalls.length, 1);

  await fire(harness, "session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(await settled, [undefined]);
  assert.equal(lifecycleSettled, true);
  compactCalls[0].onError(new Error("aborted during shutdown"));
  assert.equal(lifecycleSettled, true, "late callback remains idempotent");
});

test("同一 session 只恢复一个原 input，额外并发输入显式保存并 handled", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });
  const first = fire(harness, "input", { text: "first", source: "interactive" }, ctx);
  const second = await fire(harness, "input", {
    text: "second",
    images: [{ type: "image", data: "exact-image" }],
    source: "rpc",
  }, ctx);
  assert.deepEqual(second, [{ action: "handled" }]);
  assert.equal(compactCalls.length, 1);
  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  assert.deepEqual(await first, [undefined]);
  const preserved = harness.entries.find(
    entry => entry.type === "pi-harness-context-headroom-input",
  );
  assert.equal(preserved?.data.state, "not-delivered");
  assert.equal(preserved?.data.reason, "concurrent-headroom-input");
  assert.equal(preserved?.data.text, "second");
  assert.deepEqual(preserved?.data.images, [{ type: "image", data: "exact-image" }]);
  assert.deepEqual(harness.sent, []);
});

test("session 切换会显式保存并 handled 等待中的 input，不继续旧 pipeline", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(980_000, {
    compact: (options: any) => compactCalls.push(options),
  });
  const input = fire(harness, "input", { text: "input before switch", source: "rpc" }, ctx);
  assert.equal(compactCalls.length, 1);

  await fire(harness, "session_shutdown", { reason: "switch" }, ctx);
  assert.deepEqual(await input, [{ action: "handled" }]);
  const preserved = harness.entries.find(
    entry => entry.type === "pi-harness-context-headroom-input",
  );
  assert.equal(preserved?.data.reason, "session-changed");
  assert.equal(preserved?.data.text, "input before switch");
  compactCalls[0].onError(new Error("late cancellation callback"));
});

test("idle 普通输入先压缩再恢复原 input 管线", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(980_000, {
    compact: (options: any) => compactCalls.push(options),
  });

  let resolved = false;
  const input = fire(harness, "input", {
    text: "continue the audit",
    images: [{ type: "image", data: "fixture" }],
    source: "interactive",
  }, ctx).then(result => {
    resolved = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(compactCalls.length, 1);
  compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  assert.deepEqual(await input, [undefined]);
  assert.deepEqual(harness.sent, [], "original prompt retains text and images without extension replay");
});

test("其他 extension 发起的用户消息受保护并恢复原 input 管线", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });

  let resolved = false;
  const input = fire(harness, "input", {
    text: "extension kickoff",
    source: "extension",
  }, ctx).then(result => {
    resolved = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(compactCalls.length, 1);

  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  assert.deepEqual(await input, [undefined]);
  assert.deepEqual(harness.sent, [], "no recursive sendUserMessage replay is created");
});

test("外部 manual compaction 期间不叠加第二次压缩且不截获原输入", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });
  await fire(harness, "session_before_compact", {
    reason: "manual",
    preparation: { entriesToSummarize: [{}] },
  }, ctx);

  const input = await fire(harness, "input", {
    text: "arrived during manual compaction",
    source: "rpc",
  }, ctx);
  assert.deepEqual(input, [undefined]);
  assert.equal(compactCalls.length, 0, "headroom guard must not start a second compaction");

  tokens = 20_000;
  await fire(harness, "session_compact", { reason: "manual" }, ctx);
  assert.equal(compactCalls.length, 0);
});

test("tree summarization 失败或取消不留下永久 input latch", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });
  await fire(harness, "session_before_tree", {
    preparation: { userWantsSummary: true, entriesToSummarize: [{}] },
  }, ctx);

  const first = await fire(harness, "input", {
    text: "arrived during tree summary",
    source: "extension",
  }, ctx);
  const second = await fire(harness, "input", {
    text: "arrived after tree summary failure",
    source: "rpc",
  }, ctx);
  assert.deepEqual(first, [undefined]);
  assert.deepEqual(second, [undefined]);
  assert.equal(compactCalls.length, 0);

  // A later real agent run definitively clears the stale summarization marker,
  // allowing proactive protection to engage again.
  await fire(harness, "agent_start", {}, ctx);
  const protectedInput = fire(harness, "input", {
    text: "normal input after cancellation",
    source: "interactive",
  }, ctx);
  assert.equal(compactCalls.length, 1);
  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  assert.deepEqual(await protectedInput, [undefined]);
});

test("触发 input compaction 的 skill/template slash 继续走 Pi 原始展开管线", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    compact: (options: any) => compactCalls.push(options),
  });
  let resolved = false;
  const slashResult = fire(harness, "input", {
    text: "/skill:large-context-task",
    source: "interactive",
  }, ctx).then(result => {
    resolved = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false, "raw slash input must wait inside its original input pipeline");
  assert.equal(compactCalls.length, 1);

  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  const result = await slashResult;
  assert.equal(result[0], undefined, "Pi must receive the original slash for skill/template expansion");
  assert.deepEqual(harness.sent, [], "extension replay would skip Pi's expansion pipeline");
});

test("单个超大输入会在原 context 尚未越基线时提前压缩", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(960_000, {
    compact: (options: any) => compactCalls.push(options),
  });
  const input = fire(harness, "input", {
    text: "x".repeat(150_000),
    source: "interactive",
  }, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  assert.deepEqual(await input, [undefined]);
});

test("non-idle 输入保留 Pi 原始 steer/followUp/缺参时机", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  let tokens = 980_000;
  let idle = false;
  const ctx = runtimeContext(tokens, {
    getContextUsage: () => ({ tokens, contextWindow: WINDOW, percent: tokens / WINDOW * 100 }),
    isIdle: () => idle,
    compact: (options: any) => compactCalls.push(options),
  });

  for (const streamingBehavior of [undefined, "steer", "followUp"] as const) {
    const input = await fire(harness, "input", {
      text: "x".repeat(150_000),
      source: "interactive",
      streamingBehavior,
    }, ctx);
    assert.deepEqual(
      input,
      [undefined],
      `${streamingBehavior ?? "missing behavior"} must return to the active AgentSession immediately`,
    );
    assert.equal(compactCalls.length, 0);
  }

  idle = true;
  const settled = fire(harness, "agent_settled", {}, ctx);
  assert.equal(compactCalls.length, 1);
  assert.deepEqual(harness.sent, []);

  tokens = 20_000;
  compactCalls[0].onComplete({ estimatedTokensAfter: tokens });
  assert.deepEqual(await settled, [undefined]);
  assert.deepEqual(harness.sent, []);
});

test("提前压缩失败时只告警并恢复原 input 管线", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(980_000, {
    compact: (options: any) => compactCalls.push(options),
  });
  const input = fire(harness, "input", {
    text: "preserve me",
    source: "interactive",
  }, ctx);
  compactCalls[0].onError(new Error("fixture failure"));
  assert.deepEqual(await input, [undefined]);
  assert.deepEqual(harness.sent, []);
  assert.equal(compactCalls.length, 1, "failure must not loop into another compaction");
});

test("无 tools 的 compaction payload 不污染已观测 completion reserve", async () => {
  const harness = await registerExtension();
  const compactCalls: any[] = [];
  const ctx = runtimeContext(980_000, {
    model: { id: "test-model", contextWindow: WINDOW, maxTokens: 1_000_000 },
    compact: (options: any) => compactCalls.push(options),
  });
  await fire(harness, "session_before_compact", {
    reason: "threshold",
  }, ctx);
  const result = await fire(harness, "before_provider_request", {
    payload: { messages: [], max_tokens: 1_000 },
  }, ctx);
  assert.equal(result[0], undefined);
  await fire(harness, "session_compact", { reason: "threshold" }, ctx);
  const settled = fire(harness, "agent_settled", {}, ctx);
  assert.equal(compactCalls.length, 1, "fallback 48K reserve must remain active");
  compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  assert.deepEqual(await settled, [undefined]);
});

test("无 tools 的普通 agent 请求仍受 provider guard 保护", async () => {
  const harness = await registerExtension();
  const payload = {
    messages: [{ role: "user", content: "question" }],
    max_tokens: 48_000,
  };
  await fire(harness, "agent_start", {}, runtimeContext(1_001_471));
  const [result] = await fire(
    harness,
    "before_provider_request",
    { payload },
    runtimeContext(1_001_471, { isIdle: () => false }),
  );
  assert.equal(result.max_tokens, 30_721);
  assert.equal(payload.max_tokens, 48_000);
});

test("provider request 越线时返回收紧 output 的新 payload", async () => {
  const harness = await registerExtension();
  const payload = {
    messages: [{ role: "user", content: "question" }],
    tools: [{ type: "function", function: { name: "read" } }],
    max_tokens: 48_000,
  };
  const [result] = await fire(
    harness,
    "before_provider_request",
    { payload },
    runtimeContext(1_001_471, { isIdle: () => false }),
  );
  assert.equal(result.max_tokens, 30_721);
  assert.equal(payload.max_tokens, 48_000);
});

test("fieldless Codex adapter 保留 payload 并显式告警一次", async () => {
  const harness = await registerExtension();
  const payload = { model: "test-model", input: [{ role: "user", content: "question" }] };
  const ctx = runtimeContext(1_001_471, {
    model: {
      id: "test-model",
      api: "openai-codex-responses",
      contextWindow: WINDOW,
      maxTokens: 1_000_000,
    },
  });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const first = await fire(harness, "before_provider_request", { payload }, ctx);
    const second = await fire(harness, "before_provider_request", { payload }, ctx);
    assert.equal(first[0], undefined);
    assert.equal(second[0], undefined);
    assert.deepEqual(payload, {
      model: "test-model",
      input: [{ role: "user", content: "question" }],
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.filter(line => line.includes("fieldless output budget")).length, 1);
});

test("未知 fieldless adapter 越线时也保留 payload 并显式告警", async () => {
  const harness = await registerExtension();
  const payload = { model: "custom-model", input: [{ role: "user", content: "question" }] };
  const ctx = runtimeContext(1_001_471, {
    model: {
      id: "custom-model",
      api: "custom-api",
      contextWindow: WINDOW,
      maxTokens: 1_000_000,
    },
  });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => errors.push(args.join(" "));
  try {
    const [result] = await fire(harness, "before_provider_request", { payload }, ctx);
    assert.equal(result, undefined);
    assert.deepEqual(payload, {
      model: "custom-model",
      input: [{ role: "user", content: "question" }],
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.filter(line => (
    line.includes("custom-api") && line.includes("fieldless output budget")
  )).length, 1);
});
