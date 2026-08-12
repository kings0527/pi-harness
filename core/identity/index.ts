import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AgentProfile {
  name: string;
  specialty: string[];
  confidence_bias?: string; // e.g. "avoid guessing"
  out_of_scope: string[];
  interactionMode?: "collaborate" | "debate" | "explore"; // debate = adversarial dialectic, explore = physarum collective
}

// Role cards are package-owned assets, unlike project/workspace/global runtime knowledge.
function getAgentsRoot(): string {
  // Package root: parent of core/
  return join(import.meta.dirname || __dirname, "..", "..", "agents");
}

export function loadProfile(name: string): AgentProfile {
  const path = join(getAgentsRoot(), `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Agent profile "${name}" not found at ${path}`);
  }
  const profile = JSON.parse(readFileSync(path, "utf-8")) as AgentProfile;
  if (!profile.name || !Array.isArray(profile.specialty) || !Array.isArray(profile.out_of_scope)) {
    throw new Error(`Agent profile "${name}" is invalid: requires name, specialty[], out_of_scope[]`);
  }
  return profile;
}

export function listProfiles(): AgentProfile[] {
  const root = getAgentsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(f => f.endsWith(".json"))
    .map(f => loadProfile(f.replace(".json", "")));
}

const DEBATE_DISCIPLINE = `
DEBATE DISCIPLINE (strict):
1. EVIDENCE-BASED: Every claim MUST cite specific evidence (code, docs, data, logic). Unsupported assertions are invalid.
2. RESPOND TO EVIDENCE: Read the board before posting. If other participants have already posted, your response MUST directly address their specific arguments.
3. NO DRIFT: Do not be persuaded by rhetoric or authority. Only change your position if presented with evidence that logically disproves your current stance. State explicitly what changed your mind.
4. REFLECT: Before your final post, explicitly state: "What is the strongest point my opponent made that I cannot refute?" If nothing — explain why.
5. STEEL-MAN: Before attacking an opposing view, restate it in its strongest possible form. Attack the strong version, not a straw man.
`.trim();

const PHYSARUM_DISCIPLINE = `
COLLECTIVE INTELLIGENCE DISCIPLINE:
1. READ FIRST: Read the board before any action. Others have contributed — build on their work.
2. CONNECT: Reference other notes by #N. Your findings should link to the collective, not float alone.
3. SIGNAL: Tag leads with tags=["lead"], dead ends with tags=["deadend"], breakthroughs with priority="critical".
4. NO OVERLAP: Do not duplicate what others already explored.
5. CONVERGE: If the board already contains a strong collective answer, reinforce it rather than opening new angles.
`.trim();

/**
 * Render the system prompt fragment for a spawned subagent:
 * role, specialty, out_of_scope (refuse when out of bounds),
 * plus MUST-level collaboration discipline (board post/read).
 * If profile.interactionMode === "debate", appends dialectical discipline.
 */
export function renderSystemPrompt(profile: AgentProfile, topic: string, goal: string): string {
  const lines: string[] = [];
  lines.push(`You are "${profile.name}", a focused subagent collaborating on topic "${topic}".`);
  lines.push(`Topic goal: ${goal}`);
  lines.push(``);
  lines.push(`Your specialty: ${profile.specialty.join(", ")}.`);
  if (profile.confidence_bias) {
    lines.push(`Confidence bias: ${profile.confidence_bias}.`);
  }
  lines.push(`OUT OF SCOPE (you MUST refuse to do these): ${profile.out_of_scope.join("; ")}.`);
  lines.push(``);
  lines.push(`Collaboration discipline (MUST, not optional):`);
  lines.push(`1. Before starting, you MUST call the board tool with action=read on topic "${topic}" to learn what others already found.`);
  lines.push(`2. Whenever you discover new information, you MUST post it to the board: board tool, action=post, topic="${topic}", author="${profile.name}".`);
  lines.push(`3. You MUST NOT duplicate directions others have already explored on the board.`);
  lines.push(`4. Post at least one note with your findings before finishing. Findings not posted to the board are lost.`);

  if (profile.interactionMode === "debate") {
    lines.push(``);
    lines.push(DEBATE_DISCIPLINE);
  }

  if (profile.interactionMode === "explore") {
    lines.push(``);
    lines.push(PHYSARUM_DISCIPLINE);
  }

  return lines.join("\n");
}
