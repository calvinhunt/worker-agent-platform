import { getOpenAIClient, getTriageModel, hasOpenAIKey } from "@/lib/openai";

export type TriageDecision<TCategory extends string> = {
  category: TCategory;
  confidence: number;
  rationale: string[];
  source: "rules" | "model" | "fallback";
};

export type TriageRuleResult<TCategory extends string> = {
  category: TCategory;
  confidence: number;
  rationale: string[];
};

export type TriagePolicy<TInput, TCategory extends string> = {
  id: string;
  description: string;
  categories: readonly TCategory[];
  defaultCategory: TCategory;
  evaluateRules: (input: TInput) => TriageRuleResult<TCategory> | null;
  buildInputSummary: (input: TInput) => string;
};

function isAllowedCategory<TCategory extends string>(
  categories: readonly TCategory[],
  value: string,
): value is TCategory {
  return categories.includes(value as TCategory);
}

function parseModelJson(text: string) {
  try {
    return JSON.parse(text) as {
      category?: string;
      confidence?: number;
      rationale?: string[];
    };
  } catch {
    return null;
  }
}

export async function runTriage<TInput, TCategory extends string>(
  policy: TriagePolicy<TInput, TCategory>,
  input: TInput,
): Promise<TriageDecision<TCategory>> {
  const ruleDecision = policy.evaluateRules(input);

  if (ruleDecision) {
    return {
      ...ruleDecision,
      source: "rules",
    };
  }

  if (!hasOpenAIKey()) {
    return {
      category: policy.defaultCategory,
      confidence: 0.4,
      rationale: [
        "No API key available for model-based triage; falling back to default category.",
      ],
      source: "fallback",
    };
  }

  const modelDecision = await runModelTriage(policy, input);
  if (modelDecision) {
    return {
      ...modelDecision,
      source: "model",
    };
  }

  return {
    category: policy.defaultCategory,
    confidence: 0.3,
    rationale: ["Model triage response was unusable; falling back to default category."],
    source: "fallback",
  };
}

async function runModelTriage<TInput, TCategory extends string>(
  policy: TriagePolicy<TInput, TCategory>,
  input: TInput,
): Promise<TriageRuleResult<TCategory> | null> {
  const categoryList = policy.categories.join(", ");
  const response = await getOpenAIClient().responses.create({
    model: getTriageModel(),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              `You are a triage classifier for policy '${policy.id}'.`,
              policy.description,
              `Choose exactly one category from: ${categoryList}.`,
              "Return strict JSON only with shape:",
              '{"category":"<category>","confidence":0.0,"rationale":["..."]}',
              "Confidence must be between 0 and 1.",
              "Rationale must be 1-6 concise strings grounded in the input.",
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: policy.buildInputSummary(input),
          },
        ],
      },
    ],
    text: {
      verbosity: "low",
    },
  });

  const json = parseModelJson(response.output_text);
  if (!json?.category || typeof json.confidence !== "number" || !Array.isArray(json.rationale)) {
    return null;
  }

  if (!isAllowedCategory(policy.categories, json.category)) {
    return null;
  }

  const confidence = Math.max(0, Math.min(1, json.confidence));
  const rationale = json.rationale
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 6);

  if (!rationale.length) {
    return null;
  }

  return {
    category: json.category,
    confidence,
    rationale,
  };
}
