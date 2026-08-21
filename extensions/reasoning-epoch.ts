import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../core/events/index.ts";
import {
  createReasoningEpochMarker,
  estimateMessageReasoningTokens,
  hasToolCall,
  isUserLikeBoundary,
  REASONING_CHECKPOINT_INSTRUCTIONS,
  REASONING_EPOCH_MESSAGE_TYPE,
  type ReasoningMessage,
  resolveReasoningEpochTokenBudget,
  stripAllThinking,
  stripCompletedEpochThinking,
} from "../core/reasoning-epoch/index.ts";

interface ReasoningEpochOptions {
  tokenBudget?: number;
}

function sessionId(ctx: ExtensionContext): string {
  try {
    return String(ctx?.sessionManager?.getSessionId?.() ?? "unknown-session");
  } catch {
    return "unknown-session";
  }
}

function scrubSummaryEntries(entries: unknown[]): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as { type?: unknown; message?: Record<string, unknown> } | undefined;
    if (entry?.type !== "message" || !entry.message) continue;
    const scrubbed = stripAllThinking([entry.message])[0];
    if (scrubbed !== entry.message) entries[index] = { ...entry, message: scrubbed };
  }
}

export function createReasoningEpochExtension(options: ReasoningEpochOptions = {}) {
  const tokenBudget = resolveReasoningEpochTokenBudget(
    options.tokenBudget ?? process.env.PI_REASONING_EPOCH_TOKENS,
  );

  return async function reasoningEpochExtension(pi: ExtensionAPI) {
    const reasoningTokensBySession = new Map<string, number>();
    const queuedEpochs = new Set<string>();
    const protocolBridges = new Set<string>();

    const clearSession = (ctx: ExtensionContext) => {
      const id = sessionId(ctx);
      reasoningTokensBySession.delete(id);
      queuedEpochs.delete(id);
      protocolBridges.delete(id);
    };

    pi.on("session_start", async (_event, ctx) => clearSession(ctx));
    pi.on("session_shutdown", async (_event, ctx) => clearSession(ctx));

    pi.on("message_end", async (event, ctx) => {
      const message = event.message as unknown as ReasoningMessage;
      const id = sessionId(ctx);
      if (isUserLikeBoundary(message)) {
        reasoningTokensBySession.set(id, 0);
        queuedEpochs.delete(id);
        if (message.role === "custom" && message.customType === REASONING_EPOCH_MESSAGE_TYPE) {
          // The first provider call after a marker also carries the tool result
          // that closed the preceding response. Preserve exactly that response
          // until one successful assistant message proves the protocol bridge
          // was consumed; retries keep the bridge intact.
          protocolBridges.add(id);
        } else {
          protocolBridges.delete(id);
        }
        return;
      }
      if (message.role !== "assistant") return;

      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        protocolBridges.delete(id);
      }

      const reasoningTokens = (reasoningTokensBySession.get(id) ?? 0)
        + estimateMessageReasoningTokens(message);
      reasoningTokensBySession.set(id, reasoningTokens);
      if (reasoningTokens < tokenBudget || !hasToolCall(message) || queuedEpochs.has(id)) return;

      queuedEpochs.add(id);
      const marker = createReasoningEpochMarker(reasoningTokens, tokenBudget);
      pi.sendMessage(marker, { deliverAs: "steer" });
      console.error(
        `[reasoning-epoch] Rotating before the next provider call at ${reasoningTokens}/${tokenBudget} reasoning tokens; durable task evidence remains in context.`,
      );
      try {
        appendEvent("reasoning_epoch_queued", {
          session: id,
          reasoningTokens,
          tokenBudget,
        });
      } catch {
        // Epoch rotation must not depend on diagnostics storage.
      }
    });

    pi.on("context", async (event, ctx) => {
      const id = sessionId(ctx);
      const messages = stripCompletedEpochThinking(event.messages, {
        preserveToolProtocolBridge: protocolBridges.has(id),
      });
      return messages.some((message, index) => message !== event.messages[index])
        ? { messages: messages as typeof event.messages }
        : undefined;
    });

    pi.on("session_before_compact", async event => {
      const preparation = event.preparation as any;
      if (Array.isArray(preparation?.messagesToSummarize)) {
        preparation.messagesToSummarize = stripAllThinking(preparation.messagesToSummarize);
      }
      if (Array.isArray(preparation?.turnPrefixMessages)) {
        preparation.turnPrefixMessages = stripAllThinking(preparation.turnPrefixMessages);
      }
    });

    pi.on("session_before_tree", async event => {
      const entries = event.preparation?.entriesToSummarize;
      if (Array.isArray(entries)) scrubSummaryEntries(entries);
      if (!event.preparation?.userWantsSummary || !entries?.length) return;
      return {
        customInstructions: REASONING_CHECKPOINT_INSTRUCTIONS,
        replaceInstructions: false,
      };
    });
  };
}

export default createReasoningEpochExtension();
