import {
  Agent as OpenAIAgent,
  generateTraceId,
  OpenAIResponsesCompactionSession,
  OpenAIResponsesModel,
  type ModelSettings,
  type RunStreamEvent,
  Runner,
  shellTool,
  withTrace,
} from "@openai/agents";

import { getOpenAIClient } from "@/lib/openai";
import { FileTaskSession } from "@/lib/task-session";
import type { AdminAgentDefaults } from "@/lib/types";

const sharedRunner = new Runner({
  tracingDisabled: false,
  traceIncludeSensitiveData: true,
  workflowName: "Knowledge Agent Task",
});

type CreateRuntimeAgentInput = {
  agentName: string;
  instructions: string;
  agentDefaults: AdminAgentDefaults;
  containerId?: string;
  useHostedShell: boolean;
};

type StreamKnowledgeTaskInput = {
  taskId: string;
  agentId: string;
  agentName: string;
  agentDefaults: AdminAgentDefaults;
  sessionId: string;
  containerId?: string;
  instructions: string;
  prompt: string;
  traceId?: string;
  maxTurns?: number;
  onEvent?: (event: RunStreamEvent) => Promise<void> | void;
};

function buildModelSettings(
  agentDefaults: AdminAgentDefaults,
  options?: { useHostedShell: boolean },
): ModelSettings {
  const providerData: Record<string, unknown> = {};

  if (agentDefaults.serviceTier) {
    providerData.service_tier = agentDefaults.serviceTier;
  }

  if (agentDefaults.maxToolCalls) {
    providerData.max_tool_calls = agentDefaults.maxToolCalls;
  }

  return {
    temperature: agentDefaults.temperature ?? undefined,
    topP: agentDefaults.topP ?? undefined,
    truncation: agentDefaults.truncation ?? undefined,
    maxTokens: agentDefaults.maxOutputTokens ?? undefined,
    store: agentDefaults.store,
    parallelToolCalls: options?.useHostedShell ? agentDefaults.parallelToolCalls : false,
    promptCacheRetention: agentDefaults.promptCacheRetention ?? undefined,
    reasoning:
      agentDefaults.reasoningEffort || agentDefaults.reasoningSummary
        ? {
            effort: agentDefaults.reasoningEffort ?? undefined,
            summary: agentDefaults.reasoningSummary ?? undefined,
          }
        : undefined,
    text: agentDefaults.textVerbosity
      ? {
          verbosity: agentDefaults.textVerbosity,
        }
      : undefined,
    providerData: Object.keys(providerData).length ? providerData : undefined,
  };
}

function createRuntimeAgent(input: CreateRuntimeAgentInput) {
  const tools = input.useHostedShell
    ? [
        shellTool({
          environment: {
            type: "container_reference",
            containerId: input.containerId!,
          },
        }),
      ]
    : [];

  return new OpenAIAgent({
    name: input.agentName,
    handoffDescription: "General-purpose knowledge agent for file-aware task execution.",
    instructions: input.instructions,
    model: new OpenAIResponsesModel(getOpenAIClient(), input.agentDefaults.model),
    modelSettings: buildModelSettings(input.agentDefaults, { useHostedShell: input.useHostedShell }),
    tools,
  });
}

export function createTaskSession(sessionId: string, model: string) {
  return new OpenAIResponsesCompactionSession({
    client: getOpenAIClient(),
    underlyingSession: new FileTaskSession(sessionId),
    model,
    compactionMode: "auto",
  });
}

export async function streamKnowledgeTask(input: StreamKnowledgeTaskInput) {
  const runtimeAgent = createRuntimeAgent({
    agentName: input.agentName,
    agentDefaults: input.agentDefaults,
    instructions: input.instructions,
    containerId: input.containerId,
    useHostedShell: true,
  });
  const session = createTaskSession(input.sessionId, input.agentDefaults.model);

  let finalOutput = "";
  let responseId: string | undefined;
  let traceId: string | undefined;

  await withTrace(
    input.traceId || generateTraceId(),
    async (trace) => {
      traceId = trace.traceId;

      const stream = await sharedRunner.run(runtimeAgent, input.prompt, {
        session,
        stream: true,
        maxTurns: input.maxTurns ?? input.agentDefaults.maxTurns,
      });

      for await (const event of stream) {
        await input.onEvent?.(event);
      }

      await stream.completed;

      if (stream.error) {
        throw stream.error;
      }

      finalOutput = String(stream.finalOutput || "").trim();
      responseId = stream.lastResponseId;
    },
    {
      name: "Knowledge Agent Task Run",
      groupId: input.taskId,
      metadata: {
        agentId: input.agentId,
        agentName: input.agentName,
        containerId: input.containerId,
        sessionId: input.sessionId,
        taskId: input.taskId,
      },
    },
  );

  return {
    finalOutput,
    responseId,
    traceId,
  };
}

export async function streamKnowledgeTaskWithoutSandbox(
  input: Omit<StreamKnowledgeTaskInput, "containerId">,
) {
  const runtimeAgent = createRuntimeAgent({
    agentName: input.agentName,
    agentDefaults: input.agentDefaults,
    instructions: input.instructions,
    useHostedShell: false,
  });
  const session = createTaskSession(input.sessionId, input.agentDefaults.model);

  let finalOutput = "";
  let responseId: string | undefined;
  let traceId: string | undefined;

  await withTrace(
    input.traceId || generateTraceId(),
    async (trace) => {
      traceId = trace.traceId;

      const stream = await sharedRunner.run(runtimeAgent, input.prompt, {
        session,
        stream: true,
        maxTurns: input.maxTurns ?? input.agentDefaults.maxTurns,
      });

      for await (const event of stream) {
        await input.onEvent?.(event);
      }

      await stream.completed;

      if (stream.error) {
        throw stream.error;
      }

      finalOutput = String(stream.finalOutput || "").trim();
      responseId = stream.lastResponseId;
    },
    {
      name: "Knowledge Agent Standard Task Run",
      groupId: input.taskId,
      metadata: {
        agentId: input.agentId,
        agentName: input.agentName,
        sessionId: input.sessionId,
        taskId: input.taskId,
      },
    },
  );

  return {
    finalOutput,
    responseId,
    traceId,
  };
}
