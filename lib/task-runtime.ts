import {
  Agent as OpenAIAgent,
  generateTraceId,
  OpenAIResponsesCompactionSession,
  OpenAIResponsesModel,
  type RunStreamEvent,
  Runner,
  shellTool,
  withTrace,
} from "@openai/agents";

import { getDefaultModel, getOpenAIClient } from "@/lib/openai";
import { FileTaskSession } from "@/lib/task-session";

const sharedRunner = new Runner({
  tracingDisabled: false,
  traceIncludeSensitiveData: true,
  workflowName: "Knowledge Agent Task",
});

type CreateRuntimeAgentInput = {
  agentName: string;
  instructions: string;
  containerId?: string;
  useHostedShell: boolean;
};

type StreamKnowledgeTaskInput = {
  taskId: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  containerId?: string;
  instructions: string;
  prompt: string;
  traceId?: string;
  maxTurns?: number;
  onEvent?: (event: RunStreamEvent) => Promise<void> | void;
};

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
    model: new OpenAIResponsesModel(getOpenAIClient(), getDefaultModel()),
    modelSettings: {
      parallelToolCalls: false,
      store: true,
      text: {
        verbosity: "medium",
      },
    },
    tools,
  });
}

export function createTaskSession(sessionId: string) {
  return new OpenAIResponsesCompactionSession({
    client: getOpenAIClient(),
    underlyingSession: new FileTaskSession(sessionId),
    model: getDefaultModel(),
    compactionMode: "auto",
  });
}

export async function streamKnowledgeTask(input: StreamKnowledgeTaskInput) {
  const runtimeAgent = createRuntimeAgent({
    agentName: input.agentName,
    instructions: input.instructions,
    containerId: input.containerId,
    useHostedShell: true,
  });
  const session = createTaskSession(input.sessionId);

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
        maxTurns: input.maxTurns ?? 16,
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
    instructions: input.instructions,
    useHostedShell: false,
  });
  const session = createTaskSession(input.sessionId);

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
        maxTurns: input.maxTurns ?? 16,
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
