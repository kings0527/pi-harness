import { estimateContextTokens } from "../context-size/index.ts";

export const REASONING_EPOCH_MESSAGE_TYPE = "pi-harness-reasoning-epoch";
export const DEFAULT_REASONING_EPOCH_TOKEN_BUDGET = 32_768;
export const MIN_REASONING_EPOCH_TOKEN_BUDGET = 1_024;

export const REASONING_CHECKPOINT_INSTRUCTIONS = [
  "Preserve the durable task state as a compact factual checkpoint.",
  "Keep verified facts, hypotheses, evidence, rejected routes, unknowns, artifacts, and the next concrete test separate.",
  "Preserve exact paths, offsets, commands, errors, and observed outputs.",
  "Exclude scratchpad prose and symbolic shorthand; they are transient reasoning state, not task evidence.",
].join("\n");

export interface ReasoningContentBlock {
  type?: unknown;
  thinking?: unknown;
  id?: unknown;
}

export interface ReasoningMessage {
  role?: unknown;
  content?: unknown;
  customType?: unknown;
  toolCallId?: unknown;
  stopReason?: unknown;
  usage?: { reasoning?: unknown } | null;
}

function contentBlocks(message: ReasoningMessage): ReasoningContentBlock[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is ReasoningContentBlock => !!block && typeof block === "object")
    : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function resolveReasoningEpochTokenBudget(raw: unknown): number {
  const parsed = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
  return Math.max(
    MIN_REASONING_EPOCH_TOKEN_BUDGET,
    positiveInteger(parsed) ?? DEFAULT_REASONING_EPOCH_TOKEN_BUDGET,
  );
}

export function estimateMessageReasoningTokens(message: ReasoningMessage): number {
  if (message.role !== "assistant") return 0;
  const reasoningText = contentBlocks(message)
    .filter(block => block.type === "thinking" && typeof block.thinking === "string")
    .map(block => block.thinking as string)
    .join("\n");
  const estimated = reasoningText ? estimateContextTokens(reasoningText) : 0;
  return Math.max(positiveInteger(message.usage?.reasoning) ?? 0, estimated);
}

export function hasToolCall(message: ReasoningMessage): boolean {
  return message.role === "assistant" && contentBlocks(message).some(block => block.type === "toolCall");
}

export function isUserLikeBoundary(message: ReasoningMessage): boolean {
  return message.role === "user"
    || message.role === "custom"
    || message.role === "compactionSummary"
    || message.role === "branchSummary";
}

export function stripThinking(message: ReasoningMessage): ReasoningMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.flatMap(block => {
    if (!block || typeof block !== "object") return [block];
    const record = block as ReasoningContentBlock & {
      thoughtSignature?: unknown;
      textSignature?: unknown;
    };
    if (record.type === "thinking") {
      changed = true;
      return [];
    }
    if (record.type === "toolCall" && "thoughtSignature" in record) {
      const next = { ...record };
      delete next.thoughtSignature;
      changed = true;
      return [next];
    }
    // Gemini stores thought signatures on ordinary text parts when no function
    // call carries them. OpenAI uses the same field for replay item identity;
    // completed epochs need neither, and the visible text itself is preserved.
    if (record.type === "text" && "textSignature" in record) {
      const next = { ...record };
      delete next.textSignature;
      changed = true;
      return [next];
    }
    return [block];
  });
  return changed ? { ...message, content } : message;
}

export function stripAllThinking<T extends ReasoningMessage>(messages: readonly T[]): T[] {
  return messages.map(message => stripThinking(message) as T);
}

/**
 * Raw thinking remains intact only inside the active user/tool-use epoch.
 * A user-like message closes every preceding epoch, which matches provider
 * tool protocols: the last assistant tool call still retains its exact
 * thinking/signature until its result has been consumed.
 */
export function stripCompletedEpochThinking<T extends ReasoningMessage>(
  messages: readonly T[],
  options: { preserveToolProtocolBridge?: boolean } = {},
): T[] {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUserLikeBoundary(messages[index])) {
      boundary = index;
      break;
    }
  }
  if (boundary <= 0) return [...messages];

  let protocolBridgeIndex = -1;
  if (options.preserveToolProtocolBridge) {
    const resultIds = new Set(
      messages.slice(0, boundary)
        .filter(message => message.role === "toolResult" && typeof message.toolCallId === "string")
        .map(message => message.toolCallId as string),
    );
    for (let index = boundary - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const callIds = contentBlocks(message)
        .filter(block => block.type === "toolCall" && typeof block.id === "string")
        .map(block => block.id as string);
      if (callIds.some(id => resultIds.has(id))) protocolBridgeIndex = index;
      break;
    }
  }

  let changed = false;
  const transformed = messages.map((message, index) => {
    if (index >= boundary || index === protocolBridgeIndex) return message;
    const next = stripThinking(message) as T;
    if (next !== message) changed = true;
    return next;
  });
  return changed ? transformed : [...messages];
}

export function createReasoningEpochMarker(reasoningTokens: number, tokenBudget: number) {
  return {
    customType: REASONING_EPOCH_MESSAGE_TYPE,
    content: [
      `<reasoning_epoch state="rotated" consumed_tokens="${Math.max(0, Math.floor(reasoningTokens))}" budget="${Math.max(1, Math.floor(tokenBudget))}">`,
      "Previous hidden reasoning is closed. Continue from the durable task state already present: user requirements, visible conclusions, tool calls/results, Board and knowledge evidence, and artifacts.",
      "Start a fresh reasoning pass for the next action. Do not reproduce or summarize the prior scratchpad.",
      "</reasoning_epoch>",
    ].join("\n"),
    display: false,
    details: {
      kind: "reasoning-epoch",
      reasoningTokens: Math.max(0, Math.floor(reasoningTokens)),
      tokenBudget: Math.max(1, Math.floor(tokenBudget)),
    },
  };
}
