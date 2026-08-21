import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reasoningEpochExtension, { createReasoningEpochExtension } from "../extensions/reasoning-epoch.ts";

interface Harness {
  handlers: Record<string, Array<(event: any, ctx: any) => any>>;
  sentMessages: Array<{ message: any; options: any }>;
}

async function loadHarness(extension = reasoningEpochExtension): Promise<Harness> {
  const handlers: Harness["handlers"] = {};
  const sentMessages: Harness["sentMessages"] = [];
  await extension({
    on(name: string, handler: (event: any, ctx: any) => any) {
      (handlers[name] ??= []).push(handler);
    },
    sendMessage(message: any, options: any) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI);
  return { handlers, sentMessages };
}

async function fire(harness: Harness, name: string, event: any, ctx: any = {}): Promise<any[]> {
  return Promise.all((harness.handlers[name] ?? []).map(handler => handler(event, ctx)));
}

function assistant(thinking: string, toolId: string) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature: `sig-${toolId}` },
      { type: "text", text: `visible-${toolId}`, textSignature: `text-sig-${toolId}` },
      { type: "toolCall", id: toolId, name: "read", arguments: { path: "TARGET" }, thoughtSignature: `thought-sig-${toolId}` },
    ],
    usage: { reasoning: 16 },
    stopReason: "toolUse",
  };
}

const TELEGRAPHIC = "图片源（——seek（——VM（——但（——继续（——所以（——又（——";

test("completed reasoning epochs never replay telegraphic scratchpad into the next provider context", async () => {
  const harness = await loadHarness();
  const oldAssistant = assistant(TELEGRAPHIC, "old-call");
  const currentAssistant = assistant("current protocol reasoning", "current-call");
  const messages = [
    { role: "user", content: [{ type: "text", text: "inspect TARGET" }] },
    oldAssistant,
    { role: "toolResult", toolCallId: "old-call", toolName: "read", content: [{ type: "text", text: "old result" }] },
    { role: "custom", customType: "pi-harness-reasoning-epoch", content: "Begin fresh reasoning epoch.", display: false },
    currentAssistant,
    { role: "toolResult", toolCallId: "current-call", toolName: "read", content: [{ type: "text", text: "current result" }] },
  ];

  const results = await fire(harness, "context", { type: "context", messages });
  const transformed = results.at(-1)?.messages ?? messages;
  const serialized = JSON.stringify(transformed);

  assert.doesNotMatch(serialized, /图片源/);
  assert.match(serialized, /old-call/, "visible tool protocol remains available");
  assert.doesNotMatch(serialized, /thought-sig-old-call|text-sig-old-call/, "opaque completed-epoch reasoning is closed too");
  assert.match(serialized, /current protocol reasoning/, "current tool-use thinking/signature remains intact");
  assert.match(serialized, /thought-sig-current-call|text-sig-current-call/);
});

test("standalone compaction never receives assistant scratchpad", async () => {
  const harness = await loadHarness();
  const preparation = {
    messagesToSummarize: [assistant(TELEGRAPHIC, "summary-call")],
    turnPrefixMessages: [assistant("prefix scratchpad", "prefix-call")],
  };

  await fire(harness, "session_before_compact", {
    type: "session_before_compact",
    preparation,
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
  });

  assert.doesNotMatch(JSON.stringify(preparation), /图片源|prefix scratchpad/);
  assert.match(JSON.stringify(preparation), /summary-call|prefix-call/);
});

test("epoch boundary bridges only the unconsumed tool protocol, then closes it after provider success", async () => {
  const harness = await loadHarness();
  const ctx = { sessionManager: { getSessionId: () => "protocol-bridge-test" } };
  const oldAssistant = assistant(TELEGRAPHIC, "bridge-call");
  const marker = {
    role: "custom",
    customType: "pi-harness-reasoning-epoch",
    content: "Begin fresh reasoning epoch.",
    display: false,
  };
  const prefix = [
    { role: "user", content: [{ type: "text", text: "inspect TARGET" }] },
    oldAssistant,
    { role: "toolResult", toolCallId: "bridge-call", toolName: "read", content: [{ type: "text", text: "result" }] },
    marker,
  ];

  await fire(harness, "message_end", { type: "message_end", message: marker }, ctx);
  let results = await fire(harness, "context", { type: "context", messages: prefix }, ctx);
  assert.match(JSON.stringify(results.at(-1)?.messages ?? prefix), /图片源|thought-sig-bridge-call/);

  const successfulResponse = assistant("fresh epoch reasoning", "fresh-call");
  await fire(harness, "message_end", { type: "message_end", message: successfulResponse }, ctx);
  const continued = [...prefix, successfulResponse];
  results = await fire(harness, "context", { type: "context", messages: continued }, ctx);
  const transformed = JSON.stringify(results.at(-1)?.messages ?? continued);
  assert.doesNotMatch(transformed, /图片源|thought-sig-bridge-call/);
  assert.match(transformed, /fresh epoch reasoning|thought-sig-fresh-call/);
});

test("branch summarization receives only durable state plus factual checkpoint guidance", async () => {
  const harness = await loadHarness();
  const entries = [{
    type: "message",
    id: "assistant-entry",
    message: assistant(TELEGRAPHIC, "tree-call"),
  }];
  const results = await fire(harness, "session_before_tree", {
    type: "session_before_tree",
    preparation: {
      entriesToSummarize: entries,
      userWantsSummary: true,
    },
  });

  assert.doesNotMatch(JSON.stringify(entries), /图片源|thought-sig-tree-call/);
  assert.match(JSON.stringify(entries), /visible-tree-call|tree-call/);
  assert.match(results.at(-1)?.customInstructions, /durable task state/);
  assert.equal(results.at(-1)?.replaceInstructions, false);
});

test("fixed token capacity queues an epoch before degeneration without inspecting prose style", async () => {
  const harness = await loadHarness(createReasoningEpochExtension({ tokenBudget: 1_024 }));
  const ctx = { sessionManager: { getSessionId: () => "epoch-budget-test" } };
  await fire(harness, "session_start", { type: "session_start" }, ctx);
  await fire(harness, "message_end", {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: "inspect TARGET" }] },
  }, ctx);

  const belowBudget = assistant(TELEGRAPHIC, "below-budget");
  belowBudget.usage.reasoning = 1_023;
  await fire(harness, "message_end", { type: "message_end", message: belowBudget }, ctx);
  assert.equal(harness.sentMessages.length, 0, "telegraphic punctuation is not a trigger");

  const crossesBudget = assistant("ordinary complete sentences", "crosses-budget");
  crossesBudget.usage.reasoning = 2;
  await fire(harness, "message_end", { type: "message_end", message: crossesBudget }, ctx);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].options.deliverAs, "steer");
  assert.equal(harness.sentMessages[0].message.customType, "pi-harness-reasoning-epoch");
  assert.match(harness.sentMessages[0].message.content, /Previous hidden reasoning is closed/);
});
