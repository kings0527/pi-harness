/**
 * dsh plugin: pi-harness Board over the DeepSeek Harness tool registry.
 *
 * Scope for this first slice: the Board (`board` tool) only. It reuses the
 * runtime-agnostic core in `core/` — `runWithProjectRoot` pins the current
 * agent's session cwd for the duration of one tool call, so several projects in
 * one dsh process keep separate `.pi-board/` stores.
 *
 * The module shape is Cordis: `name`, `inject`, `Config`, `apply`. Everything
 * dsh-specific (tool definition, schemastery config, current session cwd) lives
 * here; the logic stays in `core/`.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";

import {
  closeTopic,
  getTopicCatalogEntry,
  listOpenTopics,
  listTopics,
  openTopic,
  postNote,
  readNotes,
} from "../../core/board/index.ts";
import { addEntry, getKnowledgeRoot, markConflict, type KnowledgeScope } from "../../core/knowledge/index.ts";
import { boundedExcerpt, boundedIntEnv } from "../../core/text-budget/index.ts";
import { runWithProjectRoot } from "../../core/runtime/root.ts";
import type { BoardActor, NoteKind, NoteRef, RelationKind } from "../../core/board/types.ts";

export const name = "pi-harness-board";
/** `sessions` supplies the per-agent cwd anchor the Board stores under. */
export const inject = ["tools", "sessions"];

/**
 * No `Config` export on purpose. dsh validates every plugin config, and a
 * schema here would add a second `@deepseek-ai/schemastery` instance to the
 * process for one string. The tool name is settled in code instead.
 */
export interface Config {
  /** Board tool name visible to the model. */
  toolName?: string;
}

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

function knowledgeScope(value: string | undefined): KnowledgeScope {
  return value === "workspace" ? "workspace" : value === "global" ? "global" : "project";
}

export function apply(ctx: Context, config: Config): void {
  const toolName = config?.toolName ?? "board";
  ctx.logger("pi-harness-board").info("registered the Board tool as %s", toolName);

  /** The session cwd is the Board project root; a missing session falls back to the process cwd. */
  const projectRootOf = (sessionId: string | undefined): string => {
    if (typeof sessionId !== "string" || sessionId.length === 0) return process.cwd();
    const session = ctx.sessions.get(sessionId as never);
    const cwd = session?.header?.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  };

  ctx.tools.register(
    defineTool({
      name: toolName,
      description:
        "Shared board and distill. Knowledge scope: project (current subproject), workspace (shared repo), or global.",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["open", "post", "participate", "read", "list", "close", "distill", "distill-conflict"],
        },
        topic: { type: "string", description: "Topic ID" },
        goal: { type: "string", description: "Goal for open action" },
        content: { type: "string", description: "Post or entry content" },
        mode: { type: "string", enum: ["join", "watch", "defer"] },
        reason: { type: "string", description: "Reason for participate mode" },
        kind: {
          type: "string",
          enum: [
            "declare", "plan", "claim", "evidence", "challenge", "verification", "decision", "retraction", "convergence",
          ],
        },
        targets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              topic: { type: "string", required: true },
              seq: { type: "integer", required: true },
            },
          },
        },
        relations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", required: true, enum: ["supports", "depends-on", "conflicts-with", "duplicate-of", "child-of"] },
              topic: { type: "string", required: true },
            },
          },
        },
        material: { type: "boolean" },
        verdict: { type: "string" },
        unresolved: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              topic: { type: "string", required: true },
              seq: { type: "integer", required: true },
            },
          },
        },
        author: { type: "string", description: "Author; default agent" },
        since: { type: "integer", description: "Read after seq" },
        tags: { type: "array", items: { type: "string" }, description: "Note tags" },
        priority: { type: "string", enum: ["normal", "critical"], description: "Note priority" },
        path: { type: "string", description: "Entry path within selected knowledge root" },
        scope: { type: "string", enum: ["project", "workspace", "global"], description: "project (default), workspace, or global" },
        source: { type: "string", description: "Evidence link; required for distill/conflict" },
        description: { type: "string", description: "Index or conflict summary" },
      },
      output: {
        schema: { type: "string" },
        render(_args, text) {
          return [{ type: "text", text }];
        },
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id as string | undefined;
        const root = projectRootOf(sessionId);
        const actor: BoardActor | undefined =
          typeof sessionId === "string" && sessionId.length > 0 ? { id: sessionId } : undefined;
        const requiresActor = ["open", "post", "close"].includes(args.action);
        if (requiresActor && actor === undefined) {
          throw new Error("Board write requires a stable session actor ID");
        }
        return runWithProjectRoot(root, () => dispatch(args as Record<string, unknown>, actor));
      },
    }),
  );

  function dispatch(params: Record<string, unknown>, actor: BoardActor | undefined): string {
    const str = (key: string): string | undefined => {
      const value = params[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    switch (params.action) {
      case "open": {
        const topicId = str("topic");
        const goal = str("goal");
        if (!topicId) throw new Error("topic is required for open");
        if (!goal) throw new Error("goal is required for open");
        const topic = openTopic(topicId, goal, { actor: actor!, relations: params.relations as never });
        return `Opened topic "${topicExcerpt(topic.id)}" with goal: ${goalExcerpt(topic.goal)}`;
      }
      case "post": {
        const topicId = str("topic");
        const content = str("content");
        if (!topicId) throw new Error("topic is required for post");
        if (!content) throw new Error("content is required for post");
        const author = str("author") ?? "agent";
        const note = postNote(topicId, author, content, {
          tags: params.tags as string[] | undefined,
          priority: params.priority === "critical" ? "critical" : undefined,
          actor: actor!,
          kind: params.kind as NoteKind | undefined,
          targets: params.targets as NoteRef[] | undefined,
          relations: params.relations as Array<{ type: RelationKind; topic: string }> | undefined,
          material: typeof params.material === "boolean" ? params.material : undefined,
          verdict: str("verdict"),
          unresolved: params.unresolved as NoteRef[] | undefined,
        });
        return `Posted note #${note.seq} to "${topicExcerpt(topicId)}" by ${metadataExcerpt(author)}`;
      }
      case "participate": {
        const topicId = str("topic");
        const mode = str("mode");
        if (!topicId) throw new Error("topic is required for participate");
        if (!mode) throw new Error("mode is required for participate");
        if (!listOpenTopics().some(topic => topic.id === topicId)) {
          throw new Error(`Open Board topic "${topicId}" not found`);
        }
        if ((mode === "watch" || mode === "defer") && !str("reason")) {
          throw new Error(`${mode} participation requires a reason`);
        }
        // The live feed is a pi-session concern; dsh records the accepted choice only.
        const reason = str("reason");
        return `Participation for "${topicExcerpt(topicId)}" set to ${mode}${reason ? `: ${metadataExcerpt(reason)}` : ""}.`;
      }
      case "read": {
        const topicId = str("topic");
        if (!topicId) throw new Error("topic is required for read");
        const since = typeof params.since === "number" ? params.since : undefined;
        const notes = readNotes(topicId, since);
        if (notes.length === 0) {
          return `No notes found in "${topicExcerpt(topicId)}"${since ? ` since seq ${since}` : ""}`;
        }
        return notes
          .map(n => {
            const critical = n.priority === "critical" ? " [CRITICAL]" : "";
            const kind = n.kind ? ` {${n.kind}}` : "";
            const actorId = n.actor ? ` (${n.actor.id})` : "";
            return `#${n.seq} ${n.author}${actorId}${critical}${kind}: ${n.content}`;
          })
          .join("\n");
      }
      case "list": {
        const topics = listTopics();
        if (topics.length === 0) return "No topics found.";
        return topics
          .map(t => {
            const item = getTopicCatalogEntry(t.id);
            return `- ${topicExcerpt(t.id)} [${t.status}] (${t.noteCount} notes; through #${item?.lastSeq ?? 0}; critical=${item?.criticalCount ?? 0}) — ${goalExcerpt(t.goal)}`;
          })
          .join("\n");
      }
      case "close": {
        const topicId = str("topic");
        if (!topicId) throw new Error("topic is required for close");
        closeTopic(topicId, { actor: actor! });
        return `Closed topic "${topicExcerpt(topicId)}". Summary and decisions saved to archive.\n\nNow run distill: review the archived findings and elevate valuable conclusions to long-term knowledge (board action=distill, or read the archive and use the distill skill).`;
      }
      case "distill": {
        const entryPath = str("path");
        const content = str("content");
        const description = str("description");
        if (!entryPath) throw new Error("path is required for distill");
        if (!content) throw new Error("content is required for distill");
        if (!description) throw new Error("description is required for distill");
        const scope = knowledgeScope(str("scope"));
        const source = str("source") ?? "";
        addEntry(entryPath, content, source, description, scope);
        return `Distilled entry "${metadataExcerpt(entryPath)}" (${scope}, source: ${metadataExcerpt(source)}). Updated ${metadataExcerpt(`${getKnowledgeRoot(scope)}/index.md`)}.`;
      }
      case "distill-conflict": {
        const entryPath = str("path");
        const source = str("source");
        const description = str("description");
        if (!entryPath) throw new Error("path is required for distill-conflict");
        if (!source) throw new Error("source is required for distill-conflict");
        if (!description) throw new Error("description is required for distill-conflict");
        const scope = knowledgeScope(str("scope"));
        markConflict(entryPath, source, description, scope);
        return `Marked CONFLICT on "${metadataExcerpt(entryPath)}" (${scope}, new evidence: ${metadataExcerpt(source)}). Original content preserved.`;
      }
      default:
        throw new Error(`Unknown action: ${String(params.action)}`);
    }
  }
}
