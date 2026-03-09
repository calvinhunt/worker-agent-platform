import { Agent, MemorySession, run } from "@openai/agents";
import { OpenAIResponsesModel } from "@openai/agents";

import { getDefaultModel, getOpenAIClient, hasOpenAIKey } from "@/lib/openai";

const titleAgent = hasOpenAIKey()
  ? new Agent({
      name: "TaskTitleAgent",
      instructions:
        "You create terse labels for an agent workspace. Return only a title under six words, no quotes, no punctuation at the end.",
      model: new OpenAIResponsesModel(getOpenAIClient(), getDefaultModel()),
    })
  : null;

async function suggestShortTitle(prompt: string, fallback: string) {
  if (!titleAgent) {
    return fallback;
  }

  const session = new MemorySession();
  const result = await run(titleAgent, prompt, { session });
  const title = String(result.finalOutput || "").trim();

  return title || fallback;
}

export async function suggestAgentTitle(input: {
  instructions: string;
  contextSetName: string;
}) {
  return suggestShortTitle(
    `Generate a short agent label.\nContext set: ${input.contextSetName}\nInstructions:\n${input.instructions}`,
    `${input.contextSetName} agent`,
  );
}

export async function suggestTaskTitle(input: {
  agentName: string;
  instructions: string;
  contextSetName: string;
}) {
  return suggestShortTitle(
    `Generate a short task label.\nAgent: ${input.agentName}\nContext set: ${input.contextSetName}\nInstructions:\n${input.instructions}`,
    `${input.agentName} task`,
  );
}
