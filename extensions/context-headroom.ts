import {
  assessContextHeadroom,
  clampProviderOutputBudget,
} from "../core/context-headroom/index.ts";
import { estimateContextTokens } from "../core/context-size/index.ts";
import { appendEvent } from "../core/events/index.ts";

const ESTIMATED_IMAGE_TOKENS = 1_600;

interface QueuedInput {
  deliver: () => void;
  cancel: (reason: string) => void;
  tokens: number;
}

interface PendingCompaction {
  boundary: "session_start" | "agent_settled" | "input";
  done: Promise<void>;
  settle: () => void;
}

const pendingCompactions = new Map<string, PendingCompaction>();
const queuedInputs = new Map<string, QueuedInput>();
const nonAgentProviderWork = new Set<string>();
const observedOutputByModel = new Map<string, number>();
const fieldlessWarnings = new Set<string>();

function sessionId(ctx: any): string {
  return String(ctx?.sessionManager?.getSessionId?.() ?? "unknown-session");
}

function modelKey(ctx: any): string {
  return `${ctx?.model?.provider ?? "unknown"}/${ctx?.model?.id ?? "unknown"}`;
}

function outputObservationKey(ctx: any): string {
  return [
    modelKey(ctx),
    ctx?.model?.api ?? "unknown-api",
    ctx?.model?.contextWindow ?? "unknown-window",
  ].join("|");
}

function emitEvent(type: string, details: Record<string, unknown>): void {
  try {
    appendEvent(type, details);
  } catch {
    // Runtime protection must not depend on diagnostics storage.
  }
}

function currentAssessment(
  ctx: any,
  pendingInputTokens = 0,
) {
  const usage = ctx?.getContextUsage?.();
  const contextWindow = Number(ctx?.model?.contextWindow ?? usage?.contextWindow ?? 0);
  return assessContextHeadroom({
    contextTokens: usage?.tokens,
    contextWindow,
    modelMaxOutputTokens: ctx?.model?.maxTokens,
    observedMaxOutputTokens: observedOutputByModel.get(outputObservationKey(ctx)),
    pendingInputTokens,
  });
}

export default async function (pi: any) {
  function preserveUndeliveredInput(event: any, ctx: any, reason: string): void {
    const text = String(event?.text ?? "");
    const images = Array.isArray(event?.images) ? event.images : undefined;
    let preserved = false;
    try {
      if (typeof pi.appendEntry === "function") {
        pi.appendEntry("pi-harness-context-headroom-input", {
          state: "not-delivered",
          reason,
          source: event?.source,
          text,
          ...(images ? { images } : {}),
          recordedAt: Date.now(),
        });
        preserved = true;
      }
    } catch {
      // The diagnostic below reports that persistence itself failed.
    }
    const message = preserved
      ? `Input was not delivered (${reason}); its exact text/images were preserved in a pi-harness-context-headroom-input session entry for explicit retry.`
      : `Input was not delivered (${reason}) and session-entry persistence failed; retry the original input explicitly.`;
    console.error(`[context-headroom] WARN: ${message}`);
    try {
      ctx?.ui?.notify?.(message, "warning");
    } catch {
      // stderr + events.jsonl remain operator-visible diagnostics.
    }
    emitEvent("hook_warn", {
      rule: "context-headroom-input-not-delivered",
      session: sessionId(ctx),
      reason,
      source: event?.source,
      textBytes: Buffer.byteLength(text, "utf-8"),
      imageCount: images?.length ?? 0,
      preserved,
      message,
    });
  }

  function enqueueInput(ctx: any, input: QueuedInput): void {
    queuedInputs.set(sessionId(ctx), input);
  }

  function cancelQueuedInputs(id: string): void {
    const input = queuedInputs.get(id);
    queuedInputs.delete(id);
    input?.cancel("session-changed");
  }

  function clearPendingCompaction(id: string): void {
    const pending = pendingCompactions.get(id);
    if (!pending) return;
    pendingCompactions.delete(id);
    pending.settle();
  }

  function releaseQueuedInputs(ctx: any): boolean {
    const id = sessionId(ctx);
    if (pendingCompactions.has(id) || ctx?.isIdle?.() !== true) return false;
    const input = queuedInputs.get(id);
    if (!input) {
      queuedInputs.delete(id);
      return false;
    }
    // Resume exactly one original prompt. Releasing multiple prompt pipelines
    // together lets each pass Pi's idle check before either starts the agent;
    // the later activeRun rejection happens after RPC preflight and can look
    // like a successful delivery. Additional concurrent inputs fail in their
    // input preflight instead of being silently dropped.
    queuedInputs.delete(id);
    input.deliver();
    return true;
  }

  function beginCompaction(
    ctx: any,
    boundary: "session_start" | "agent_settled" | "input",
    pendingInputTokens = 0,
  ): PendingCompaction | null {
    const id = sessionId(ctx);
    if (pendingCompactions.has(id) || nonAgentProviderWork.has(id)) return null;
    const assessment = currentAssessment(ctx, pendingInputTokens);
    if (!assessment.shouldCompact) return null;

    let resolveDone!: () => void;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolveDone();
    };
    const state: PendingCompaction = {
      boundary,
      done: new Promise<void>(resolve => {
        resolveDone = resolve;
      }),
      settle,
    };
    pendingCompactions.set(id, state);
    const message = `Pre-compacting at ${boundary}: ${assessment.contextTokens}/${assessment.contextWindow} tokens; reserving ${assessment.outputReserveTokens} output + ${assessment.ingressReserveTokens} ingress.`;
    console.error(`[context-headroom] WARN: ${message}`);
    emitEvent("context_headroom_compact", {
      boundary,
      session: id,
      ...assessment,
      message,
    });

    const finish = (_result?: { estimatedTokensAfter?: number }) => {
      if (pendingCompactions.get(id) === state) {
        pendingCompactions.delete(id);
        nonAgentProviderWork.delete(id);
        releaseQueuedInputs(ctx);
      }
      settle();
    };
    const fail = (error: Error) => {
      if (pendingCompactions.get(id) === state) {
        nonAgentProviderWork.delete(id);
        const errorMessage = `Pre-compaction at ${boundary} failed: ${error.message}`;
        console.error(`[context-headroom] WARN: ${errorMessage}`);
        emitEvent("hook_warn", {
          rule: "context-headroom-compaction-failed",
          boundary,
          session: id,
          message: errorMessage,
        });
        // The user's original input remains the source of truth even when the
        // proactive compaction attempt itself fails.
        pendingCompactions.delete(id);
        releaseQueuedInputs(ctx);
      }
      settle();
    };
    try {
      ctx.compact({ onComplete: finish, onError: fail });
    } catch (error: any) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return state;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    const id = sessionId(ctx);
    clearPendingCompaction(id);
    cancelQueuedInputs(id);
    nonAgentProviderWork.delete(id);
    for (const key of fieldlessWarnings) {
      if (key.startsWith(`${id}:`)) fieldlessWarnings.delete(key);
    }
    // A just-shutdown session may still be draining its provider stream;
    // newSession() against a streaming predecessor is rejected by Pi. Wait
    // for the actual idle boundary before touching ctx.compact() so the
    // proactive check neither races the predecessor nor fires while
    // pre-compaction state is inconsistent.
    if (!ctx?.isIdle?.()) await ctx.waitForIdle();
    const compaction = beginCompaction(ctx, "session_start");
    // Pi 0.84 rejects prompt() before the input hook while a manual
    // compaction controller exists. Keep session initialization pending until
    // our proactive compaction settles, so callers never observe that gap.
    if (compaction) await compaction.done;
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    nonAgentProviderWork.add(sessionId(ctx));
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    nonAgentProviderWork.delete(sessionId(ctx));
    releaseQueuedInputs(ctx);
  });

  pi.on("session_before_tree", async (event: any, ctx: any) => {
    if (event?.preparation?.userWantsSummary && event.preparation.entriesToSummarize?.length > 0) {
      nonAgentProviderWork.add(sessionId(ctx));
    }
  });

  pi.on("session_tree", async (_event: any, ctx: any) => {
    nonAgentProviderWork.delete(sessionId(ctx));
    releaseQueuedInputs(ctx);
  });

  // A normal agent loop is definitive evidence that any failed/cancelled
  // summarization request is no longer active.
  pi.on("agent_start", async (_event: any, ctx: any) => {
    nonAgentProviderWork.delete(sessionId(ctx));
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    const id = sessionId(ctx);
    clearPendingCompaction(id);
    cancelQueuedInputs(id);
    nonAgentProviderWork.delete(id);
    for (const key of fieldlessWarnings) {
      if (key.startsWith(`${id}:`)) fieldlessWarnings.delete(key);
    }
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (releaseQueuedInputs(ctx)) return;
    const compaction = beginCompaction(ctx, "agent_settled");
    // AgentSession publishes agent_settled only after extension handlers
    // return. Awaiting here prevents the UI/RPC idle boundary from racing the
    // prompt-before-input compaction rejection.
    if (compaction) await compaction.done;
  });

  pi.on("input", async (event: any, ctx: any) => {
    const text = String(event.text ?? "");
    const pendingInputTokens = estimateContextTokens(text)
      + (Array.isArray(event.images) ? event.images.length * ESTIMATED_IMAGE_TOKENS : 0);
    let resolvePipeline: ((result: "deliver" | "cancel") => void) | undefined;
    const id = sessionId(ctx);
    // Any non-idle input is already inside Pi's streaming path. Suspending it
    // would turn steer/followUp into a later standalone prompt, and would even
    // turn Pi's missing-streamingBehavior error into success. Preserve the
    // original queue/interrupt/error timing; provider guard covers this loop.
    if (ctx?.isIdle?.() !== true) return;
    // Pi exposes success events for compaction/tree work, but no matching
    // failure/cancel event. While foreign summarization owns the session, skip
    // our proactive compaction and leave delivery to the original Pi caller;
    // persisting a busy latch here would deadlock every later input on failure.
    if (nonAgentProviderWork.has(id)) return;
    if (queuedInputs.has(id)) {
      preserveUndeliveredInput(event, ctx, "concurrent-headroom-input");
      return { action: "handled" };
    }
    const mustWait = pendingCompactions.has(id)
      || currentAssessment(ctx, pendingInputTokens).shouldCompact;
    if (!mustWait) return;

    const pipelineResult = new Promise<"deliver" | "cancel">(resolve => {
      resolvePipeline = resolve;
    });
    const queuedInput: QueuedInput = {
      deliver: () => resolvePipeline?.("deliver"),
      cancel: reason => {
        preserveUndeliveredInput(event, ctx, reason);
        resolvePipeline?.("cancel");
      },
      tokens: pendingInputTokens,
    };
    enqueueInput(ctx, queuedInput);
    // Keep the original AgentSession.prompt() suspended instead of fabricating
    // an extension replay. Resuming this promise preserves upstream transforms,
    // downstream input hooks, images, source semantics, and Pi's skill/template
    // expansion while this high-risk input waits on the compaction barrier.
    if (!pendingCompactions.has(id)) {
      if (!beginCompaction(ctx, "input", queuedInput.tokens)) releaseQueuedInputs(ctx);
    }
    return (await pipelineResult) === "cancel" ? { action: "handled" } : undefined;
  });

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (nonAgentProviderWork.has(sessionId(ctx))) return;
    const usage = ctx?.getContextUsage?.();
    const result = clampProviderOutputBudget(payload, {
      contextTokens: usage?.tokens,
      contextWindow: Number(ctx?.model?.contextWindow ?? usage?.contextWindow ?? 0),
    });
    if (typeof result.requestedTokens === "number") {
      const key = outputObservationKey(ctx);
      observedOutputByModel.set(
        key,
        Math.max(observedOutputByModel.get(key) ?? 0, result.requestedTokens),
      );
    }
    if (typeof result.requestedTokens !== "number") {
      const warningKey = `${sessionId(ctx)}:${modelKey(ctx)}:${ctx?.model?.api ?? "unknown-api"}`;
      const assessment = currentAssessment(ctx);
      if (!assessment.shouldCompact) {
        fieldlessWarnings.delete(warningKey);
        return;
      }
      if (!fieldlessWarnings.has(warningKey)) {
        fieldlessWarnings.add(warningKey);
        const message = `Provider adapter ${ctx.model.api} has a fieldless output budget, so the last-mile guard preserved the request unchanged; proactive compaction remains the protection boundary.`;
        console.error(`[context-headroom] WARN: ${message}`);
        emitEvent("hook_warn", {
          rule: "context-headroom-fieldless-output",
          session: sessionId(ctx),
          model: modelKey(ctx),
          api: ctx.model.api,
          ...assessment,
          message,
        });
      }
      return;
    }
    if (!result.changed) return;

    const message = `Provider output budget clamped from ${result.requestedTokens} to ${result.allowedTokens} tokens because the current request is inside the context headroom margin; message content was preserved.`;
    console.error(`[context-headroom] WARN: ${message}`);
    emitEvent("hook_warn", {
      rule: "context-headroom-output-clamp",
      session: sessionId(ctx),
      model: modelKey(ctx),
      field: result.field,
      requestedTokens: result.requestedTokens,
      allowedTokens: result.allowedTokens,
      contextTokens: usage?.tokens,
      contextWindow: usage?.contextWindow ?? ctx?.model?.contextWindow,
      message,
    });
    return result.payload;
  });
}
