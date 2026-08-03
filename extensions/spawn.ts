import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { listProfiles, loadProfile } from "../core/identity/index.ts";
import { spawnAgents } from "../core/spawn/index.ts";
import type { SpawnOptions } from "../core/spawn/index.ts";
import { listTopics } from "../core/board/index.ts";
import { getStormConfig } from "../core/storm/index.ts";

export default async function(pi: any) {
  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagents",
    description: "Spawn role-carded subagents that investigate in parallel and post findings to the board. Actions: list (available profiles), run (agents: [{profile, task}], topic must be open), debate (topic, question — storm must be enabled, spawns advocate+critic with different models). Spawn parallel agents proactively when a task has independent investigation directions.",
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

            const advocateProfile = loadProfile("advocate");
            const criticProfile = loadProfile("critic");

            const debateOpts: SpawnOptions[] = [
              {
                profile: advocateProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Defend the following with evidence and rigorous argument:\n"${params.question}"\nYou MUST find the strongest possible case FOR this position.`,
                cwd: process.cwd(),
                model: storm.models[0],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              },
              {
                profile: criticProfile,
                topic: params.topic,
                task: `DEBATE POSITION: Challenge and stress-test the following claim:\n"${params.question}"\nYou MUST find the strongest counterexamples and logical gaps AGAINST this position.`,
                cwd: process.cwd(),
                model: storm.models[1],
                ...(params.timeoutMs && { timeoutMs: params.timeoutMs }),
              },
            ];

            onUpdate?.({ content: [{ type: "text" as const, text: `⚡ Storm debate: advocate (${storm.models[0]}) vs critic (${storm.models[1]}) on: "${params.question}"` }] });

            const debateResults = await spawnAgents(debateOpts);

            const debateFormatted = debateResults.map(r => {
              const status = r.timedOut ? "TIMED OUT" : `exit ${r.exitCode}`;
              return `## ${r.name} [${status}]\n${r.output || "(no output)"}`;
            }).join("\n\n");
            return { content: [{ type: "text" as const, text: `${debateFormatted}\n\n---\n⚡ Debate round complete. Now \`board read ${params.topic}\` to synthesize both positions. Consider: where do they agree? Where is the evidence strongest? What remains unresolved?` }] };
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
