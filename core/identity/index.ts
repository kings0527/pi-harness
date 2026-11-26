import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface AgentProfile {
  name: string;
  specialty: string[];
  confidence_bias?: string; // e.g. "avoid guessing"
  out_of_scope: string[];
  interactionMode?: "collaborate" | "debate" | "explore"; // debate = adversarial dialectic, explore = live flux field
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

export const FLUX_DISCIPLINE = `
COLLECTIVE INTELLIGENCE DISCIPLINE (Live Flux):
1. DRIVE BY WORLD FEEDBACK: Keep probing the real environment until you reach a verified breakthrough, genuine saturation across angles, or a concrete external block. Never stop early just to deliver a progress report.
2. INITIAL LENS, NOT A CAGE: Your starting lens breaks initial symmetry. Follow stronger live gradients (your own or peers' in [FIELD Δ]) whenever environment feedback justifies pivoting.
3. OBJECTIVE ECHOES ONLY: Emit \`field action=pulse\` (method -> observed echo -> next heading) on decision-changing feedback. Never output confidence scores, never grade peers, and never declare a target unconditionally dead — name the method tested so other angles remain open.
4. COHERENT OVERLAP & EXCLUSIVE RESOURCES: Avoid repeating the exact same check a peer just ran; use orthogonal angles on high-traction leads or factual conflicts. Coordinate exclusive mutable targets via \`field action=claim\` / \`release\`, and share reusable outputs in the field artifacts dir (\`kind=artifact\`).
5. CONVERGE ON BREACH: Emit \`field action=pulse kind=breach\` immediately on a verified breakthrough. When a peer emits \`breach\`, evaluate it against the full goal — independently verify, close remaining gaps, or finish cleanly.
`.trim();

export interface RenderPromptOptions {
  fieldId?: string;
  actorLabel?: string;
  lens?: string;
  lensGuidance?: string;
  artifactsPath?: string;
}

/**
 * Render the prompt fragment for a spawned subagent:
 * role, specialty, out_of_scope, plus collaboration/debate/explore discipline.
 */
export function renderSystemPrompt(
  profile: AgentProfile,
  topic: string,
  goal: string,
  options: RenderPromptOptions = {},
): string {
  const lines: string[] = [];
  const identityLabel = options.actorLabel || profile.name;
  lines.push(`You are "${identityLabel}", a focused subagent collaborating on topic "${topic}".`);
  lines.push(`Goal: ${goal}`);
  lines.push(``);
  lines.push(`Your specialty: ${profile.specialty.join(", ")}.`);
  if (profile.confidence_bias) {
    lines.push(`Operating stance: ${profile.confidence_bias}.`);
  }
  lines.push(`OUT OF SCOPE: ${profile.out_of_scope.join("; ")}.`);

  if (profile.interactionMode === "explore" && options.fieldId) {
    lines.push(``);
    lines.push(`Live Field: "${options.fieldId}" (full sideline discipline is loaded in your system prompt; [FIELD Δ] arrives automatically after tool calls).`);
    if (options.lens) {
      lines.push(`Starting lens (decaying initial bias): ${options.lens}${options.lensGuidance ? ` — ${options.lensGuidance}` : ""}`);
    }
    if (options.artifactsPath) {
      lines.push(`Shared artifacts dir (write reusable dumps/traces/scripts here): ${options.artifactsPath}`);
    }
    lines.push(`Start probing the real environment immediately. Emit concise objective echoes via \`field action=pulse\` (and \`kind="breach"\` on verified breakthrough).`);
    return lines.join("\n");
  }

  lines.push(``);
  lines.push(`Collaboration discipline (MUST, not optional):`);
  lines.push(`1. Before starting, you MUST call the board tool with action=read on topic "${topic}" to learn what others already found.`);
  lines.push(`2. Whenever you discover new information, you MUST post it to the board: board tool, action=post, topic="${topic}", author="${profile.name}".`);
  lines.push(`3. Avoid duplicating identical work others already completed on the board; add new evidence or an orthogonal check.`);
  lines.push(`4. Post at least one note with your findings before finishing. Findings not posted to the board are lost.`);

  if (profile.interactionMode === "debate") {
    lines.push(``);
    lines.push(DEBATE_DISCIPLINE);
  }

  if (profile.interactionMode === "explore") {
    lines.push(``);
    lines.push(FLUX_DISCIPLINE);
  }

  return lines.join("\n");
}
