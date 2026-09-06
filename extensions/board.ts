import { Type } from "typebox";
import { join } from "node:path";
// 注意：extension 中引用 core/ 时使用相对路径
import { openTopic, postNote, readNotes, listTopics, listOpenTopics, getTopicCatalogEntry, closeTopic } from "../core/board/index.ts";
import type { BoardActor, NoteKind, NoteRef, RelationKind } from "../core/board/types.ts";
import { addEntry, getKnowledgeRoot, markConflict, type KnowledgeScope } from "../core/knowledge/index.ts";
import { boundedExcerpt, boundedIntEnv } from "../core/text-budget/index.ts";

/** Tool echoes are provider-visible on later turns, so user-controlled fields are bounded. */
function goalExcerpt(goal: string): string {
  return boundedExcerpt(goal, boundedIntEnv("PI_BOARD_GOAL_EXCERPT_BYTES", 240));
}

function topicExcerpt(topic: string): string {
  return boundedExcerpt(topic, boundedIntEnv("PI_BOARD_TOPIC_EXCERPT_BYTES", 240));
}

function metadataExcerpt(value: string): string {
  return boundedExcerpt(value, boundedIntEnv("PI_BOARD_TOOL_ECHO_EXCERPT_BYTES", 240));
}

export default async function(pi: any) {
  const parentBySession = new Map<string, string>();
  // Pi creates a fresh session ID on fork/clone. Record only actual fork
  // lineage; resume/new may have a previous file but are not ancestry.
  pi.on?.("session_start", async (event: any, ctx: any) => {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id !== "string" || !id) return;
    if (event?.reason === "fork" && typeof event.previousSessionFile === "string" && event.previousSessionFile) {
      parentBySession.set(id, event.previousSessionFile);
    } else {
      parentBySession.delete(id);
    }
  });
  pi.on?.("session_shutdown", async (_event: any, ctx: any) => {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string") parentBySession.delete(id);
  });

  pi.registerTool({
    name: "board",
    label: "Shared Blackboard",
    description: "Shared board and distill. Knowledge scope: project (current subproject), workspace (shared repo), or global.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("open"),
        Type.Literal("post"),
        Type.Literal("participate"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("close"),
        Type.Literal("distill"),
        Type.Literal("distill-conflict"),
      ]),
      topic: Type.Optional(Type.String({ description: "Topic ID" })),
      goal: Type.Optional(Type.String({ description: "Goal for open action" })),
      content: Type.Optional(Type.String({ description: "Post or entry content" })),
      mode: Type.Optional(Type.Union([Type.Literal("join"), Type.Literal("watch"), Type.Literal("defer")])),
      reason: Type.Optional(Type.String({ description: "Reason for participate mode" })),
      kind: Type.Optional(Type.Union([
        Type.Literal("declare"), Type.Literal("plan"), Type.Literal("claim"), Type.Literal("evidence"),
        Type.Literal("challenge"), Type.Literal("verification"), Type.Literal("decision"), Type.Literal("retraction"), Type.Literal("convergence"),
      ])),
      targets: Type.Optional(Type.Array(Type.Object({ topic: Type.String(), seq: Type.Integer({ minimum: 1 }) }))),
      relations: Type.Optional(Type.Array(Type.Object({
        type: Type.Union([Type.Literal("supports"), Type.Literal("depends-on"), Type.Literal("conflicts-with"), Type.Literal("duplicate-of"), Type.Literal("child-of")]),
        topic: Type.String(),
      }))),
      material: Type.Optional(Type.Boolean()),
      verdict: Type.Optional(Type.String()),
      unresolved: Type.Optional(Type.Array(Type.Object({ topic: Type.String(), seq: Type.Integer({ minimum: 1 }) }))),
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
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        const requiresActor = ["open", "post", "close"].includes(params.action);
        if (requiresActor && (typeof sessionId !== "string" || sessionId.trim() === "")) {
          throw new Error("Board write requires a stable Pi session actor ID");
        }
        // Pi assigns a new session ID to fork/clone and preserves it on resume;
        // never forge ancestry from a display label or a caller-supplied author.
        const actor: BoardActor | undefined = typeof sessionId === "string" && sessionId.trim()
          ? { id: sessionId, ...(parentBySession.get(sessionId) && { parentSession: parentBySession.get(sessionId)! }) }
          : undefined;
        switch (params.action) {
          case "open": {
            if (!params.topic) throw new Error("topic is required for open");
            if (!params.goal) throw new Error("goal is required for open");
            const topic = openTopic(params.topic, params.goal, { actor: actor!, relations: params.relations as any });
            return {
              content: [{ type: "text" as const, text: `Opened topic "${topicExcerpt(topic.id)}" with goal: ${goalExcerpt(topic.goal)}` }],
              details: { action: "open", topic: topic.id },
            };
          }
          case "post": {
            if (!params.topic) throw new Error("topic is required for post");
            if (!params.content) throw new Error("content is required for post");
            const author = params.author || "agent";
            const priority = params.priority === "critical" ? "critical" as const : undefined;
            const note = postNote(params.topic, author, params.content, {
              tags: params.tags,
              priority,
              actor: actor!,
              kind: params.kind as NoteKind | undefined,
              targets: params.targets as NoteRef[] | undefined,
              relations: params.relations as Array<{ type: RelationKind; topic: string }> | undefined,
              material: params.material,
              verdict: params.verdict,
              unresolved: params.unresolved as NoteRef[] | undefined,
            });
            return {
              content: [{ type: "text" as const, text: `Posted note #${note.seq} to "${topicExcerpt(params.topic)}" by ${metadataExcerpt(author)}` }],
              details: { action: "post", topic: params.topic, noteSeq: note.seq },
            };
          }
          case "participate": {
            if (!params.topic) throw new Error("topic is required for participate");
            if (!params.mode) throw new Error("mode is required for participate");
            // Participation affects a live feed cursor, so accepting a typo or
            // archived ID would persist a permanently unreadable membership.
            if (!listOpenTopics().some(topic => topic.id === params.topic)) {
              throw new Error(`Open Board topic "${params.topic}" not found`);
            }
            if ((params.mode === "watch" || params.mode === "defer")
              && (typeof params.reason !== "string" || params.reason.trim() === "")) {
              throw new Error(`${params.mode} participation requires a reason`);
            }
            // Context-feed persists the session-scoped choice from the successful
            // tool_result. Core Board remains globally append-only and does not
            // mistake one session's view preference for topic state.
            return { content: [{ type: "text" as const, text: `Participation for "${topicExcerpt(params.topic)}" set to ${params.mode}${params.reason ? `: ${metadataExcerpt(params.reason)}` : ""}.` }], details: { action: "participate", topic: params.topic, mode: params.mode, reason: params.reason } };
          }
          case "read": {
            if (!params.topic) throw new Error("topic is required for read");
            const notes = readNotes(params.topic, params.since);
            if (notes.length === 0) {
              return { content: [{ type: "text" as const, text: `No notes found in "${topicExcerpt(params.topic)}"${params.since ? ` since seq ${params.since}` : ""}` }] };
            }
            const formatted = notes.map(n => {
              const p = n.priority === "critical" ? " [CRITICAL]" : "";
              const kind = n.kind ? ` {${n.kind}}` : "";
              const actor = n.actor ? ` (${n.actor.id})` : "";
              return `#${n.seq} ${n.author}${actor}${p}${kind}: ${n.content}`;
            }).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "list": {
            const topics = listTopics();
            if (topics.length === 0) {
              return { content: [{ type: "text" as const, text: "No topics found." }] };
            }
            const formatted = topics.map(t => {
              const item = getTopicCatalogEntry(t.id);
              return `- ${topicExcerpt(t.id)} [${t.status}] (${t.noteCount} notes; through #${item?.lastSeq ?? 0}; critical=${item?.criticalCount ?? 0}) — ${goalExcerpt(t.goal)}`;
            }).join("\n");
            return { content: [{ type: "text" as const, text: formatted }] };
          }
          case "close": {
            if (!params.topic) throw new Error("topic is required for close");
            const result = closeTopic(params.topic, { actor: actor! });
            return {
              content: [{ type: "text" as const, text: `Closed topic "${topicExcerpt(params.topic)}". Summary and decisions saved to archive.\n\nNow run distill: review the archived findings and elevate valuable conclusions to long-term knowledge (board action=distill, or read the archive and use the distill skill).` }],
              details: { action: "close", topic: params.topic },
            };
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
            return { content: [{ type: "text" as const, text: `Distilled entry "${metadataExcerpt(params.path)}" (${scope}, source: ${metadataExcerpt(params.source ?? "")}). Updated ${metadataExcerpt(indexPath)}.` }] };
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
            return { content: [{ type: "text" as const, text: `Marked CONFLICT on "${metadataExcerpt(params.path)}" (${conflictScope}, new evidence: ${metadataExcerpt(params.source ?? "")}). Original content preserved.` }] };
          }
          default:
            throw new Error(`Unknown action: ${params.action}`);
        }
      } catch (err: any) {
        // Pi marks a tool_result as failed only when execute rejects. Encoding
        // an error in a resolved result leaves the runtime event isError=false
        // and can make downstream hooks treat a failed mutation as persisted.
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  });
}
