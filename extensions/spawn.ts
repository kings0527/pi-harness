import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { listProfiles, loadProfile } from "../core/identity/index.ts";
import { spawnAgent, spawnAgents } from "../core/spawn/index.ts";
import type { SpawnOptions } from "../core/spawn/index.ts";
import { listTopics, openTopic, postNote, readNotes, closeTopic } from "../core/board/index.ts";
import { getStormConfig } from "../core/storm/index.ts";
import { getPhysarumConfig } from "../core/physarum/index.ts";
import { assessContextSize } from "../core/context-size/index.ts";
import { appendEvent } from "../core/events/index.ts";

function warnIfLargeResult(text: string, ctx: any, action: string): void {
  const contextWindow = ctx?.model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const assessment = assessContextSize(text, contextWindow);
  if (!assessment.shouldWarn) return;

  const message = `Full spawn ${action} output preserved: ~${assessment.estimatedTokens} tokens (${(assessment.ratio * 100).toFixed(1)}% of ${contextWindow}). Review agent output and Board notes for duplication or excessive verbosity.`;
  console.error(`[spawn] WARN: ${message}`);
  try {
    appendEvent("hook_warn", { rule: "spawn-output-size", action, ...assessment, message });
  } catch {
    // Warning persistence must not alter the tool result.
  }
}

export default async function(pi: any) {
  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagents",
    description: "Spawn Board collaborators. Actions: list, run, debate, physarum.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("run"),
        Type.Literal("debate"),
        Type.Literal("physarum"),
      ]),
      topic: Type.Optional(Type.String({ description: "Open Board topic" })),
      agents: Type.Optional(Type.Array(Type.Object({
        profile: Type.String({ description: "Agent profile" }),
        task: Type.String({ description: "Concrete task" }),
      }), { description: "Parallel agents" })),
      question: Type.Optional(Type.String({ description: "Debate/exploration question" })),
      angles: Type.Optional(Type.Array(Type.String(), { description: "Physarum angles" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Timeout per agent" })),
    }),
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      try {
        switch (params.action) {
          case "list": {
            const profiles = listProfiles();
            if (profiles.length === 0) {
              return { content: [{ type: "text" as const, text: "No agent profiles found in agents/." }] };
            }
            const formatted = profiles.map(p =>
              `- ${p.name}: specialty [${p.specialty.join(", ")}]; out_of_scope [${p.out_of_scope.join(", ")}]${p.confidence_bias ? `; bias: ${p.confidence_bias}` : ""}`
            ).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "run": {
            if (!params.topic) throw new Error("topic is required for run");
            if (!params.agents?.length) throw new Error("agents is required for run");

            // 校验 topic 存在且 open
            const topics = listTopics();
            const meta = topics.find((t: any) => t.id === params.topic);
            if (!meta) throw new Error(`Topic "${params.topic}" not found — open it with the board tool first`);
            if (meta.status !== "open") throw new Error(`Topic "${params.topic}" is ${meta.status}, not open`);

            const optsList: SpawnOptions[] = params.agents.map((a: any) => ({
              profile: loadProfile(a.profile),
              topic: params.topic,
              task: a.task,
              cwd: process.cwd(),
              ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
            }));

            const names = optsList.map(o => o.profile.name).join(", ");
            onUpdate?.({ content: [{ type: "text" as const, text: `Spawning ${optsList.length} subagent(s) in parallel: ${names} ...` }] });

            const results = await spawnAgents(optsList);

            const formatted = results.map(r => {
              const status = r.timedOut ? "TIMED OUT" : `exit ${r.exitCode}`;
              return `## ${r.name} (${status})\n${r.output || "(no output)"}`;
            }).join("\n\n");
            const resultText = `${formatted}\n\n---\nNow \`board read ${params.topic}\` to check convergence — if gaps remain, spawn another round.`;
            warnIfLargeResult(resultText, ctx, "run");
            return { content: [{ type: "text" as const, text: resultText }] };
          }
          case "debate": {
            if (!params.topic) throw new Error("topic is required for debate");
            if (!params.question) throw new Error("question is required for debate");

            const storm = getStormConfig();
            if (!storm.enabled) throw new Error("Storm mode is disabled. Enable it with /storm on <model1>,<model2>");
            if (storm.models.length < 2) throw new Error("Storm requires at least 2 models. Configure with /storm on <model1>,<model2>");

            // 校验 topic 存在且 open
            const debateTopics = listTopics();
            const debateMeta = debateTopics.find((t: any) => t.id === params.topic);
            if (!debateMeta) throw new Error(`Topic "${params.topic}" not found — open it with the board tool first`);
            if (debateMeta.status !== "open") throw new Error(`Topic "${params.topic}" is ${debateMeta.status}, not open`);

            const models = storm.models;

            // 动态构建参与者列表
            const participants: SpawnOptions[] = [];

            if (models.length === 2) {
              // 经典对抗：advocate vs critic
              const advocateProfile = loadProfile("advocate");
              const criticProfile = loadProfile("critic");
              participants.push({
                profile: advocateProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Defend the following with evidence and rigorous argument:\n"${params.question}"\nYou MUST find the strongest possible case FOR this position.`,
                cwd: process.cwd(),
                model: models[0],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              });
              participants.push({
                profile: criticProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Challenge and stress-test the following claim:\n"${params.question}"\nYou MUST find the strongest counterexamples and logical gaps AGAINST this position.\nREAD THE BOARD FIRST — the advocate has already posted their arguments. You MUST directly address their specific points.`,
                cwd: process.cwd(),
                model: models[1],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              });
            } else {
              // N 个独立分析者：每个用自己的模型独立分析
              for (let i = 0; i < models.length; i++) {
                participants.push({
                  profile: {
                    name: `analyst-${i + 1}`,
                    specialty: ["independent analysis", "evidence-based reasoning"],
                    confidence_bias: "form your own conclusion independently before reading others",
                    out_of_scope: ["agreeing without evidence", "repeating others without adding new insight"],
                    interactionMode: "debate" as const,
                  },
                  topic: params.topic,
                  task: `INDEPENDENT ANALYSIS: Analyze the following question from your own perspective with evidence and rigorous reasoning:\n"${params.question}"\nREAD THE BOARD FIRST — if others have already posted, you MUST address their points: agree with evidence or refute with counter-evidence. Add NEW insight, do not merely repeat.`,
                  cwd: process.cwd(),
                  model: models[i],
                  ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
                });
              }
            }

            const participantSummary = participants.map((p, i) => `${p.profile.name} (${models[i]})`).join(", ");
            onUpdate?.({ content: [{ type: "text" as const, text: `⚡ Storm debate: ${participants.length} participants [${participantSummary}] on: "${params.question}"` }] });

            // 串行执行（回合制）——每个都能读到前面的论点
            const debateResults = [];
            for (let i = 0; i < participants.length; i++) {
              const result = await spawnAgent(participants[i]);
              debateResults.push(result);
              if (i < participants.length - 1) {
                onUpdate?.({ content: [{ type: "text" as const, text: `${result.name} finished (exit ${result.exitCode}). Spawning ${participants[i + 1].profile.name}...` }] });
              }
            }

            const debateFormatted = debateResults.map((r, i) => {
              const status = r.timedOut ? "TIMED OUT" : `exit ${r.exitCode}`;
              return `## ${r.name} [${models[i]}] (${status})\n${r.output || "(no output)"}`;
            }).join("\n\n");
            const debateText = `${debateFormatted}\n\n---\n⚡ Debate round complete (${debateResults.length} participants). Now \`board read ${params.topic}\` to synthesize all positions. Consider: where do they agree? Where is the evidence strongest? What remains unresolved?`;
            warnIfLargeResult(debateText, ctx, "debate");
            return { content: [{ type: "text" as const, text: debateText }] };
          }
          case "physarum": {
            if (!params.topic) throw new Error("topic is required for physarum");
            if (!params.question) throw new Error("question is required for physarum");

            const config = getPhysarumConfig();
            if (!config.enabled) throw new Error("Physarum mode is disabled. Enable with /physarum on <models>");

            // 校验主 topic open
            const pTopics = listTopics();
            const pMeta = pTopics.find((t: any) => t.id === params.topic);
            if (!pMeta) throw new Error(`Topic "${params.topic}" not found`);
            if (pMeta.status !== "open") throw new Error(`Topic "${params.topic}" is ${pMeta.status}, not open`);

            const maxPulses = Math.min(config.maxPulses ?? 3, 5);
            const tentacleCount = Math.min(config.tentacles ?? Math.max(config.models.length, 2), 6);

            // 创建工作子 topic
            const workingTopicId = `${params.topic}--physarum-${Date.now()}`;
            openTopic(workingTopicId, params.question);

            let actualPulses = 0;
            try {
              for (let pulse = 1; pulse <= maxPulses; pulse++) {
                actualPulses = pulse;
                const isFirstPulse = pulse === 1;
                const isLastPulse = pulse === maxPulses;

                // 构造 N 个 tentacle
                const participants: SpawnOptions[] = [];
                for (let i = 0; i < tentacleCount; i++) {
                  const angle = params.angles?.[i];
                  let taskBody: string;

                  if (isLastPulse) {
                    taskBody = `PULSE ${pulse}/${maxPulses} — SYNTHESIZE: Read the ENTIRE board. The collective has explored for ${pulse - 1} rounds. Now SYNTHESIZE: merge all findings into a coherent answer. Post your synthesis with priority="critical".\nQuestion: "${params.question}"`;
                  } else if (isFirstPulse) {
                    taskBody = `PULSE ${pulse}/${maxPulses} — DIVERGE: Explore this angle: "${angle || `pick a distinct direction after reading the board (you are tentacle ${i + 1} of ${tentacleCount})`}"\nQuestion: "${params.question}"`;
                  } else {
                    taskBody = `PULSE ${pulse}/${maxPulses} — BUILD & CONVERGE: Read the board. Build on the strongest leads from previous pulses. Deepen, refine, cross-pollinate. If your angle hit a dead end, pivot to reinforce a promising direction others found.\nQuestion: "${params.question}"`;
                  }

                  participants.push({
                    profile: loadProfile("tentacle"),
                    topic: workingTopicId,
                    task: taskBody,
                    cwd: process.cwd(),
                    model: config.models[i % config.models.length],
                    ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
                  });
                }

                const phaseLabel = isFirstPulse ? "diverging" : isLastPulse ? "synthesizing" : "building & converging";
                onUpdate?.({ content: [{ type: "text" as const, text: `🍄 Pulse ${pulse}/${maxPulses}: ${tentacleCount} tentacles ${phaseLabel}...` }] });

                // 并行 spawn 本轮所有触角
                const results = await spawnAgents(participants);

                // 早停：所有输出都很短 → 自然收敛信号
                if (!isFirstPulse && !isLastPulse) {
                  const allBrief = results.every(r => (r.output?.length ?? 0) < 200);
                  if (allBrief) {
                    onUpdate?.({ content: [{ type: "text" as const, text: `📡 Pulse ${pulse}: all tentacles converged (brief outputs). Stopping early.` }] });
                    break;
                  }
                }
              }

              // 从工作子 topic 提取综合结论（priority=critical 的 notes）
              const allNotes = readNotes(workingTopicId);
              const criticalNotes = allNotes.filter((n: any) => n.priority === "critical");
              const synthesisContent = criticalNotes.length > 0
                ? criticalNotes.map((n: any) => n.content).join("\n\n---\n\n")
                : allNotes.map((n: any) => `${n.author}: ${n.content}`).join("\n\n");

              // 将综合结论 post 到主 topic
              postNote(params.topic, "physarum", synthesisContent, { tags: ["physarum-synthesis"] });

            } finally {
              // 归档工作子 topic（零副作用保证）
              try { closeTopic(workingTopicId); } catch {}
            }

            return { content: [{ type: "text" as const, text: `🌿 Physarum complete (${actualPulses} pulses, ${tentacleCount} tentacles). Collective synthesis posted to topic "${params.topic}".\n\nNow \`board read ${params.topic}\` to see the result, then consider \`board close\` → \`distill\`.` }] };
          }
          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Error: ${err.message}` }] };
      }
    }
  });
}
