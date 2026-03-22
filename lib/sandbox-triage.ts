import { runTriage, type TriagePolicy } from "@/lib/triage";

type SandboxCategory = "sandbox" | "standard";

export type SandboxTriageInput = {
  prompt: string;
  agentName: string;
  agentInstructions: string;
  contextSetName: string;
};

const SANDBOX_POSITIVE_PATTERNS = [
  /\b(write|edit|refactor|fix|patch|implement|change|update)\b/i,
  /\b(run|execute|test|lint|build|compile|benchmark|profile)\b/i,
  /\b(codebase|repository|repo|files?|directory|folder|dataset|csv|jsonl?)\b/i,
  /\bpython|node|bash|shell|sql|notebook|analysis\b/i,
  /\b\/mnt\/data\b/i,
];

const STANDARD_POSITIVE_PATTERNS = [
  /\b(explain|summarize|brainstorm|outline|compare|pros and cons|what is|how does)\b/i,
  /\bwithout (writing|changing|editing|running)\b/i,
  /\bno code\b/i,
];

function scorePrompt(prompt: string, patterns: RegExp[]) {
  return patterns.reduce((count, pattern) => (pattern.test(prompt) ? count + 1 : count), 0);
}

const sandboxNeedPolicy: TriagePolicy<SandboxTriageInput, SandboxCategory> = {
  id: "sandbox_need",
  description:
    "Classify whether a request should run in a hosted shell/container environment. Sandbox is needed when tasks require file operations, code changes, command execution, or data analysis over local artifacts.",
  categories: ["sandbox", "standard"],
  defaultCategory: "sandbox",
  evaluateRules(input) {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return {
        category: "standard",
        confidence: 0.95,
        rationale: ["Prompt is empty; no container task is implied."],
      };
    }

    const sandboxScore = scorePrompt(prompt, SANDBOX_POSITIVE_PATTERNS);
    const standardScore = scorePrompt(prompt, STANDARD_POSITIVE_PATTERNS);

    if (sandboxScore >= 2) {
      return {
        category: "sandbox",
        confidence: 0.9,
        rationale: [
          "Prompt includes multiple file/code/command cues that strongly suggest sandbox usage.",
        ],
      };
    }

    if (standardScore >= 1 && sandboxScore === 0) {
      return {
        category: "standard",
        confidence: 0.82,
        rationale: ["Prompt appears informational and does not request file or command operations."],
      };
    }

    return null;
  },
  buildInputSummary(input) {
    return [
      `Prompt: ${input.prompt}`,
      `Agent name: ${input.agentName}`,
      `Context set: ${input.contextSetName}`,
      "Agent instructions:",
      input.agentInstructions,
    ].join("\n");
  },
};

export function triageSandboxNeed(input: SandboxTriageInput) {
  return runTriage(sandboxNeedPolicy, input);
}
