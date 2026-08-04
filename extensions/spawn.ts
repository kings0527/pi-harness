import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { listProfiles, loadProfile } from "../core/identity/index.ts";
import { spawnAgent, spawnAgents } from "../core/spawn/index.ts";
import type { SpawnOptions } from "../core/spawn/index.ts";
import { listTopics } from "../core/board/index.ts";
import { getStormConfig } from "../core/storm/index.ts";

export default async function(pi: any) {
  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagents",
    description: "Spawn subagents to investigate and post findings to the board. Actions: list, run (parallel agents), debate (storm adversarial).",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("run"),
        Type.Literal("debate"),
      ]),
      topic: Type.Optional(Type.String({ description: "Open topic the subagents collaborate on (required for run/debate)" })),
      agents: Type.Optional(Type.Array(Type.Object({
        profile: Type.String({ description: "Profile name, e.g. scout / worker / reviewer" }),
        task: Type.String({ description: "Concrete investigation task for this subagent" }),
      }), { description: "Subagents to launch in parallel (required for run)" })),
      question: Type.Optional(Type.String({ description: "The specific question to debate (required for debate action)" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Per-agent timeout in ms (default 600000)" })),
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
            return { content: [{ type: "text" as const, text: `${formatted}\n\n---\nNow \`board read ${params.topic}\` to check convergence — if gaps remain, spawn another round.` }] };
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
            return { content: [{ type: "text" as const, text: `${debateFormatted}\n\n---\n⚡ Debate round complete (${debateResults.length} participants). Now \`board read ${params.topic}\` to synthesize all positions. Consider: where do they agree? Where is the evidence strongest? What remains unresolved?` }] };
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
