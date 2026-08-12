import { Type } from "typebox";
import { join } from "node:path";
// 注意：extension 中引用 core/ 时使用相对路径
import { openTopic, postNote, readNotes, listTopics, closeTopic } from "../core/board/index.ts";
import { addEntry, getKnowledgeRoot, markConflict, type KnowledgeScope } from "../core/knowledge/index.ts";

export default async function(pi: any) {
  pi.registerTool({
    name: "board",
    label: "Shared Blackboard",
    description: "Shared board and distill. Knowledge scope: project (current subproject), workspace (shared repo), or global.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("post"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("close"),
        Type.Literal("distill"),
        Type.Literal("distill-conflict"),
      ]),
      topic: Type.Optional(Type.String({ description: "Topic ID" })),
      goal: Type.Optional(Type.String({ description: "Goal for open action" })),
      content: Type.Optional(Type.String({ description: "Post or entry content" })),
      author: Type.Optional(Type.String({ description: "Author; default agent" })),
      since: Type.Optional(Type.Integer({ description: "Read after seq" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Note tags" })),
      priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("critical")], { description: "Note priority" })),
      path: Type.Optional(Type.String({ description: "Entry path within selected knowledge root" })),
      scope: Type.Optional(Type.Union([
        Type.Literal("project"),
        Type.Literal("workspace"),
        Type.Literal("global"),
      ], { description: "project (default), workspace, or global" })),
      source: Type.Optional(Type.String({ description: "Evidence link; required for distill/conflict" })),
      description: Type.Optional(Type.String({ description: "Index or conflict summary" })),
    }),
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      try {
        switch (params.action) {
          case "open": {
            if (!params.topic) throw new Error("topic is required for open");
            if (!params.goal) throw new Error("goal is required for open");
            const topic = openTopic(params.topic, params.goal);
            return { content: [{ type: "text" as const, text: `Opened topic "${topic.id}" with goal: ${topic.goal}` }] };
          }
          case "post": {
            if (!params.topic) throw new Error("topic is required for post");
            if (!params.content) throw new Error("content is required for post");
            const author = params.author || "agent";
            const priority = params.priority === "critical" ? "critical" as const : undefined;
            const note = postNote(params.topic, author, params.content, { tags: params.tags, priority });
            return {
              content: [{ type: "text" as const, text: `Posted note #${note.seq} to "${params.topic}" by ${author}` }],
              details: { action: "post", topic: params.topic, noteSeq: note.seq },
            };
          }
          case "read": {
            if (!params.topic) throw new Error("topic is required for read");
            const notes = readNotes(params.topic, params.since);
            if (notes.length === 0) {
              return { content: [{ type: "text" as const, text: `No notes found in "${params.topic}"${params.since ? ` since seq ${params.since}` : ""}` }] };
            }
            const formatted = notes.map(n => {
              const p = n.priority === "critical" ? " [CRITICAL]" : "";
              return `#${n.seq} ${n.author}${p}: ${n.content}`;
            }).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "list": {
            const topics = listTopics();
            if (topics.length === 0) {
              return { content: [{ type: "text" as const, text: "No topics found." }] };
            }
            const formatted = topics.map(t => `- ${t.id} [${t.status}] (${t.noteCount} notes) — ${t.goal}`).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "close": {
            if (!params.topic) throw new Error("topic is required for close");
            const result = closeTopic(params.topic);
            return { content: [{ type: "text" as const, text: `Closed topic "${params.topic}". Summary and decisions saved to archive.\n\nNow run distill: review the archived findings and elevate valuable conclusions to long-term knowledge (board action=distill, or read the archive and use the distill skill).` }] };
          }
          case "distill": {
            if (!params.path) throw new Error("path is required for distill");
            if (!params.content) throw new Error("content is required for distill");
            if (!params.description) throw new Error("description is required for distill");
            // 溯源校验（无溯源即拒绝）由 addEntry 单点持有，这里原样透传
            const scope: KnowledgeScope = params.scope === "workspace"
              ? "workspace"
              : params.scope === "global" ? "global" : "project";
            addEntry(params.path, params.content, params.source ?? "", params.description, scope);
            const indexPath = join(getKnowledgeRoot(scope), "index.md");
            return { content: [{ type: "text" as const, text: `Distilled entry "${params.path}" (${scope}, source: ${params.source}). Updated ${indexPath}.` }] };
          }
          case "distill-conflict": {
            if (!params.path) throw new Error("path is required for distill-conflict");
            if (!params.source) throw new Error("source is required for distill-conflict");
            if (!params.description) throw new Error("description is required for distill-conflict");
            // CONFLICT 只追加不覆盖，由 markConflict 保证
            const conflictScope: KnowledgeScope = params.scope === "workspace"
              ? "workspace"
              : params.scope === "global" ? "global" : "project";
            markConflict(params.path, params.source, params.description, conflictScope);
            return { content: [{ type: "text" as const, text: `Marked CONFLICT on "${params.path}" (${conflictScope}, new evidence: ${params.source}). Original content preserved.` }] };
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
