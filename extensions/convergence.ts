import { readNotes } from "../core/board/index.ts";
import { appendEvent } from "../core/events/index.ts";

const CLOSE_BLOCK_REASON = `Board close blocked: no convergence note found. First evaluate the board against the topic goal, then post your verdict with tags=["convergence"] (state why the goal is or isn't met). If gaps remain, spawn another round instead of closing.`;

export default async function(pi: any) {
  // Per-topic spawn 轮次计数（进程内有效）
  const spawnRounds = new Map<string, number>();

  // Hook A: close 门禁 —— 收敛判断归 LLM，存在性校验归 runtime
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "board") return;
    const input = event.input || event.args;
    if (input?.action !== "close" || !input?.topic) return;

    let notes: any[];
    try {
      notes = readNotes(input.topic);
    } catch {
      return; // topic 不存在等 —— 交给 board 工具自己报错
    }
    const hasConvergence = notes.some(n => Array.isArray(n.tags) && n.tags.includes("convergence"));
    if (hasConvergence) return;

    appendEvent("hook_block", {
      rule: "convergence-gate",
      topic: input.topic,
      reason: CLOSE_BLOCK_REASON,
    });
    return { block: true, reason: CLOSE_BLOCK_REASON };
  });

  // Hook B: 轮次护栏 —— 只观测提醒，不阻止（判断归 LLM）
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName !== "spawn") return;
    const input = event.input || event.args;
    if (input?.action !== "run" || !input?.topic) return;

    const round = (spawnRounds.get(input.topic) ?? 0) + 1;
    spawnRounds.set(input.topic, round);
    if (round >= 4) {
      console.error(`[convergence] WARN: topic "${input.topic}" is on spawn round ${round} — reflect on whether the direction is wrong before spawning more`);
      appendEvent("hook_warn", {
        rule: "spawn-round-guard",
        topic: input.topic,
        round,
        message: "4+ spawn rounds on one topic — consider whether the approach needs rethinking",
      });
    }
  });
}
