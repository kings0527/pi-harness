import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assessContextSize } from "../core/context-size/index.ts";
import { appendEvent } from "../core/events/index.ts";
import {
  beginGoalTurn,
  clearGoal,
  completeGoalFromBoardNote,
  createGoalReferenceSnapshot,
  getGoal,
  goalEvidenceTag,
  pauseGoal,
  resumeGoal,
  setGoal,
  GOAL_MET_TAG,
  type GoalReferenceSnapshot,
} from "../core/goal/index.ts";

const GOAL_MESSAGE_TYPE = "pi-harness-goal";
const LEGACY_STATUS_MESSAGE_TYPE = "goal-status";
const GOAL_SNAPSHOT_ENTRY_TYPE = "pi-harness-goal-snapshot";

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, level);
}

function activeGoalMessage(snapshot: GoalReferenceSnapshot) {
  return {
    role: "custom" as const,
    customType: GOAL_MESSAGE_TYPE,
    content: snapshot.content,
    display: false,
    details: {
      goalId: snapshot.goalId,
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      userTurnCount: snapshot.userTurnCount,
      frozenAt: snapshot.frozenAt,
    },
    timestamp: snapshot.frozenAt,
  };
}

export default async function goalExtension(pi: ExtensionAPI) {
  const frozenBySession = new Map<string, GoalReferenceSnapshot>();
  const warnedGoalIds = new Set<string>();

  pi.registerCommand("goal", {
    description: "Set a session-persistent execution goal. Usage: /goal <condition> | pause | resume | off | status",
    async handler(args, ctx) {
      const id = sessionId(ctx);
      const trimmed = args.trim();

      if (!trimmed || trimmed === "status") {
        const goal = getGoal(id);
        if (!goal) {
          notify(ctx, "No goal in this session. Set one with /goal <condition>.");
          return;
        }
        const evidence = goal.evidence ? `\nEvidence: Board ${goal.evidence.topic}#${goal.evidence.noteSeq}` : "";
        notify(
          ctx,
          `Goal: ${goal.text}\nStatus: ${goal.status}\nUser turns: ${goal.userTurnCount}\nID: ${goal.id}${evidence}`,
        );
        return;
      }

      if (trimmed === "pause") {
        const paused = pauseGoal(id);
        notify(ctx, paused ? `Goal paused: ${paused.text}` : "No active goal to pause.", paused ? "info" : "warning");
        frozenBySession.delete(id);
        return;
      }

      if (trimmed === "resume") {
        const resumed = resumeGoal(id);
        notify(ctx, resumed ? `Goal resumed: ${resumed.text}` : "No paused goal to resume.", resumed ? "info" : "warning");
        frozenBySession.delete(id);
        return;
      }

      if (trimmed === "off") {
        const cleared = clearGoal(id);
        notify(ctx, cleared ? `Goal cleared: ${cleared.text}` : "No goal to clear.", cleared ? "info" : "warning");
        frozenBySession.delete(id);
        return;
      }

      const goal = setGoal(id, trimmed);
      frozenBySession.delete(id);
      notify(
        ctx,
        `Goal set: ${goal.text}\nCompletion tags: ${GOAL_MET_TAG}, ${goalEvidenceTag(goal.id)}`,
      );
    },
    getArgumentCompletions(prefix) {
      return ["status", "pause", "resume", "off"]
        .filter(command => command.startsWith(prefix))
        .map(command => ({ label: command, value: command }));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    frozenBySession.delete(sessionId(ctx));
  });

  // before_agent_start is the sole per-user-prompt refresh boundary (ADR-0013).
  pi.on("before_agent_start", async (_event, ctx) => {
    const id = sessionId(ctx);
    const current = getGoal(id);
    if (!current || current.status !== "active") {
      frozenBySession.delete(id);
      return;
    }

    const advanced = beginGoalTurn(id, current.id);
    if (!advanced) {
      frozenBySession.delete(id);
      return;
    }

    const snapshot = createGoalReferenceSnapshot(advanced);
    frozenBySession.set(id, snapshot);
    const metadata = {
      sessionId: id,
      goalId: advanced.id,
      snapshotId: snapshot.id,
      path: snapshot.path,
      bytes: snapshot.bytes,
      userTurnCount: snapshot.userTurnCount,
      frozenAt: snapshot.frozenAt,
    };
    pi.appendEntry(GOAL_SNAPSHOT_ENTRY_TYPE, metadata);
    appendEvent("goal_snapshot", metadata);

    const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
    if (contextWindow && !warnedGoalIds.has(advanced.id)) {
      const assessment = assessContextSize(snapshot.content, contextWindow);
      if (assessment.shouldWarn) {
        warnedGoalIds.add(advanced.id);
        const message = `Goal reference is ~${assessment.estimatedTokens} tokens (${(assessment.ratio * 100).toFixed(1)}% of ${contextWindow}); full text preserved.`;
        console.error(`[goal] WARN: ${message}`);
        appendEvent("hook_warn", {
          rule: "goal-context-size",
          sessionId: id,
          goalId: advanced.id,
          ...assessment,
          message,
        });
      }
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = event.messages.filter(
      message => !(message.role === "custom"
        && (message.customType === GOAL_MESSAGE_TYPE || message.customType === LEGACY_STATUS_MESSAGE_TYPE)),
    );
    const snapshot = frozenBySession.get(sessionId(ctx));
    if (!snapshot) return messages.length === event.messages.length ? {} : { messages };

    let insertionIndex = messages.length;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        insertionIndex = index;
        break;
      }
    }
    messages.splice(insertionIndex, 0, activeGoalMessage(snapshot));
    return { messages };
  });

  // Completion is evaluated only after Board execution and verified against the persisted note.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "board" || event.isError) return;
    const input = event.input as { action?: unknown; topic?: unknown; tags?: unknown };
    if (input.action !== "post" || typeof input.topic !== "string" || !Array.isArray(input.tags)) return;
    if (!input.tags.includes(GOAL_MET_TAG)) return;

    const details = event.details as { action?: string; topic?: string; noteSeq?: unknown } | undefined;
    const noteSeq = details?.noteSeq;
    if (details?.action !== "post" || details.topic !== input.topic || typeof noteSeq !== "number" || !Number.isInteger(noteSeq)) return;
    const id = sessionId(ctx);
    const current = getGoal(id);
    if (!current || current.status !== "active" || !input.tags.includes(goalEvidenceTag(current.id))) return;

    const completed = completeGoalFromBoardNote(id, current.id, input.topic, noteSeq);
    if (!completed) return;
    notify(ctx, `Goal achieved: ${completed.text}`);
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Goal ${completed.id} verified and marked achieved from Board ${input.topic}#${noteSeq}.`,
        },
      ],
    };
  });
}
