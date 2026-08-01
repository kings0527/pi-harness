import { Type } from "typebox";
// 注意：extension 中引用 core/ 时使用相对路径
import { openTopic, postNote, readNotes, listTopics, closeTopic } from "../core/board/index.ts";

export default async function(pi: any) {
  pi.registerTool({
    name: "board",
    label: "Shared Blackboard",
    description: "Topic-based shared blackboard for multi-agent collaboration. Actions: open <topic> --goal, post <topic> <content>, read <topic> [--since seq], list, close <topic>.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("post"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("close"),
      ]),
      topic: Type.Optional(Type.String({ description: "Topic ID" })),
      goal: Type.Optional(Type.String({ description: "Goal for open action" })),
      content: Type.Optional(Type.String({ description: "Note content for post action" })),
      author: Type.Optional(Type.String({ description: "Author name (defaults to agent)" })),
      since: Type.Optional(Type.Integer({ description: "Seq number for incremental read" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for the note" })),
      priority: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("critical")], { description: "Note priority" })),
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
            return { content: [{ type: "text" as const, text: `Posted note #${note.seq} to "${params.topic}" by ${author}` }] };
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
            return { content: [{ type: "text" as const, text: `Closed topic "${params.topic}". Summary and decisions generated in archive.` }] };
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
