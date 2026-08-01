import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateDigest } from "../core/board/digest.ts";
import { listTopics } from "../core/board/index.ts";
import { getStorageRoot } from "../core/storage/index.ts";

// Knowledge index cache
let knowledgeIndexCache: { content: string; fetchedAt: number } | null = null;
const KNOWLEDGE_CACHE_TTL = 60_000; // 60 seconds

// Track which topics this agent participates in
const participatingTopics = new Set<string>();

// Last injected seq per topic (to avoid duplicate injection)
const lastInjectedSeq = new Map<string, number>();

function getKnowledgeIndex(): string {
  // Check cache freshness
  if (knowledgeIndexCache && Date.now() - knowledgeIndexCache.fetchedAt < KNOWLEDGE_CACHE_TTL) {
    return knowledgeIndexCache.content;
  }

  // Try to read knowledge/index.md from package root
  const packageRoot = join(import.meta.dirname || process.cwd(), "..");
  const indexPath = join(packageRoot, "knowledge", "index.md");

  if (!existsSync(indexPath)) {
    knowledgeIndexCache = { content: "", fetchedAt: Date.now() };
    return "";
  }

  const content = readFileSync(indexPath, "utf-8").trim();
  knowledgeIndexCache = { content, fetchedAt: Date.now() };
  return content;
}

export default async function (pi: any) {
  // Track participation: when agent posts to a topic, record it
  pi.on("tool_result", async (event: any, _ctx: any) => {
    const toolName = event.tool || event.toolName;
    if (toolName === "board") {
      // If the tool call was a "post" or "open", mark participation
      const input = event.input || event.args || {};
      if (input.action === "open" || input.action === "post") {
        if (input.topic) {
          participatingTopics.add(input.topic);
        }
      }
    }
  });

  // Context injection hook — fires before every LLM call
  pi.on("context", async (event: any, _ctx: any) => {
    const injections: string[] = [];
    let totalBudget = 3000; // bytes

    // 1. Knowledge index (always inject if non-empty)
    const knowledgeIndex = getKnowledgeIndex();
    if (knowledgeIndex) {
      const knowledgeSection = `[Knowledge Index]\n${knowledgeIndex}`;
      const kBytes = Buffer.byteLength(knowledgeSection, "utf-8");
      if (kBytes < 500) { // Knowledge index should be small
        injections.push(knowledgeSection);
        totalBudget -= kBytes;
      }
    }

    // 2. Board digests for participating topics
    if (participatingTopics.size > 0) {
      try {
        const topics = listTopics();
        const openParticipating = topics.filter(
          t => t.status === "open" && participatingTopics.has(t.id)
        );

        for (const topic of openParticipating) {
          if (totalBudget <= 100) break; // Reserve minimum space

          const digest = generateDigest(topic.id, {
            lastSeq: 0, // Always generate full digest for injection
            maxBytes: Math.min(totalBudget, 1500), // Cap per-topic
          });

          if (digest.text) {
            const section = `[Board: ${topic.id}]\nGoal: ${topic.goal}\n${digest.text}`;
            injections.push(section);
            totalBudget -= Buffer.byteLength(section, "utf-8");
            lastInjectedSeq.set(topic.id, digest.lastSeq);
          }
        }
      } catch {
        // Board might not exist yet — silently skip
      }
    }

    // 3. Inject as context message if we have content
    if (injections.length > 0) {
      const injectedContent = injections.join("\n\n---\n\n");

      // Modify the messages array to include our injection
      if (event.messages && Array.isArray(event.messages)) {
        event.messages.push({
          role: "user",
          content: [{ type: "text", text: `[pi-harness context]\n${injectedContent}` }],
        });
      }
    }

    // Return modified context (if the API expects a return value)
    return {};
  });
}
