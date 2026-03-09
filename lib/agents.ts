import { Agent, MemorySession, run } from "@openai/agents";
import { OpenAIResponsesModel } from "@openai/agents";

import { getDefaultModel, getOpenAIClient, hasOpenAIKey } from "@/lib/openai";

const titleAgent = hasOpenAIKey()
  ? new Agent({
      name: "TaskTitleAgent",
      instructions:
        "You create terse task labels for a coding work queue. Return only a title under six words, no quotes, no punctuation at the end.",
      model: new OpenAIResponsesModel(getOpenAIClient(), getDefaultModel()),
    })
  : null;

export async function suggestTaskTitle(input: {
  instructions: string;
  contextSetName: string;
}) {
  if (!titleAgent) {
    return `${input.contextSetName} task`;
  }

  const session = new MemorySession();
  const result = await run(
    titleAgent,
    `Context set: ${input.contextSetName}\nInstructions:\n${input.instructions}`,
    { session },
  );

  const title = String(result.finalOutput || "").trim();
  return title || `${input.contextSetName} task`;
}
