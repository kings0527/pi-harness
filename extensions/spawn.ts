import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { listProfiles, loadProfile } from "../core/identity/index.ts";
import { spawnAgents, SpawnOptions } from "../core/spawn/index.ts";
import { listTopics } from "../core/board/index.ts";

export default async function(pi: any) {
  pi.registerTool({
    name: "spawn",
    label: "Spawn Subagents",
    description: "Spawn role-carded subagents that investigate in parallel and post findings to the board. Actions: list (available profiles), run (agents: [{profile, task}], topic must be open). Spawn parallel agents proactively when a task has independent investigation directions.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("run"),
      ]),
      topic: Type.Optional(Type.String({ description: "Open topic the subagents collaborate on (required for run)" })),
      agents: Type.Optional(Type.Array(Type.Object({
        profile: Type.String({ description: "Profile name, e.g. scout / worker / reviewer" }),
        task: Type.String({ description: "Concrete investigation task for this subagent" }),
      }), { description: "Subagents to launch in parallel (required for run)" })),
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
            return { content: [{ type: "text" as const, text: `${formatted}\n\n---\nUse board read ${params.topic} to see the findings they posted.` }] };
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
