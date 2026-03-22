import { NextResponse } from "next/server";

import { generateTraceId } from "@openai/agents";

import { streamKnowledgeTask, streamKnowledgeTaskWithoutSandbox } from "@/lib/task-runtime";
import { triageSandboxNeed } from "@/lib/sandbox-triage";
import {
  buildAgentInstructions,
  ensureTaskReady,
  getTaskContext,
  setTaskStatus,
  startTaskRun,
  syncTaskArtifacts,
  summarizeShellOutput,
  updateTaskAfterRun,
} from "@/lib/tasks";

export const runtime = "nodejs";

type RequestBody = {
  prompt?: string;
};

function streamLine(payload: unknown) {
  return `${JSON.stringify(payload)}\n`;
}

function isHostedShellLoadFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("load failed");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await context.params;
  const body = (await request.json()) as RequestBody;
  const prompt = String(body.prompt || "").trim();

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (payload: unknown) => {
        controller.enqueue(encoder.encode(streamLine(payload)));
      };
      let assistantDraft = "";
      let runId: string | undefined;
      const traceId = generateTraceId();

      try {
        const { run } = await startTaskRun(taskId, { traceId });
        runId = run.id;
        write({ type: "status", status: "running" });

        const { task: existingTask, agent, contextSet } = await getTaskContext(taskId);
        const triage = await triageSandboxNeed({
          prompt,
          agentName: agent.name,
          agentInstructions: agent.instructions,
          contextSetName: contextSet.name,
        });
        const shouldUseSandbox = triage.category === "sandbox";

        write({
          type: "update",
          message: shouldUseSandbox
            ? `Triage selected hosted shell mode (${triage.source}, confidence ${triage.confidence.toFixed(2)}).`
            : `Triage selected standard mode without hosted shell (${triage.source}, confidence ${triage.confidence.toFixed(2)}).`,
        });

        let responseId: string | undefined;
        let assistantText = "";
        let cachedArtifacts = existingTask.artifacts;

        if (shouldUseSandbox) {
          const { task, containerWasCreated, containerWasReset } = await ensureTaskReady(taskId);
          write({
            type: "update",
            message: containerWasReset
              ? `Hosted container expired. Recreated container ${task.containerId}.`
              : containerWasCreated
                ? `Prepared hosted container ${task.containerId}.`
                : `Using container ${task.containerId}`,
          });

          async function runSandboxedTask(input: { sessionId: string; containerId: string; reset: boolean }) {
            return streamKnowledgeTask({
              taskId,
              agentId: agent.id,
              agentName: agent.name,
              sessionId: input.sessionId,
              containerId: input.containerId,
              instructions: buildAgentInstructions(task, agent, contextSet, {
                containerWasReset: input.reset,
              }),
              prompt,
              traceId,
              onEvent(event) {
                if (event.type === "raw_model_stream_event") {
                  switch (event.data.type) {
                    case "output_text_delta":
                      assistantDraft += event.data.delta;
                      write({ type: "assistant_delta", delta: event.data.delta });
                      break;
                    case "response_done":
                      write({
                        type: "update",
                        message: "Model response completed. Gathering /mnt/data artifacts.",
                      });
                      break;
                    default:
                      break;
                  }

                  return;
                }

                if (event.type === "run_item_stream_event") {
                  if (
                    event.name === "tool_called" &&
                    event.item.type === "tool_call_item" &&
                    event.item.rawItem?.type === "shell_call"
                  ) {
                    write({
                      type: "update",
                      message: `Running shell step: ${event.item.rawItem.action.commands.join(" && ")}`,
                    });
                    return;
                  }

                  if (
                    event.name === "tool_output" &&
                    event.item.type === "tool_call_output_item" &&
                    event.item.rawItem?.type === "shell_call_output"
                  ) {
                    const summary = summarizeShellOutput(event.item.rawItem.output);
                    if (summary) {
                      write({
                        type: "shell_output",
                        output: summary,
                      });
                    }
                  }
                }
              },
            });
          }

          let sandboxResult: Awaited<ReturnType<typeof streamKnowledgeTask>>;
          try {
            sandboxResult = await runSandboxedTask({
              sessionId: task.sessionId,
              containerId: task.containerId!,
              reset: containerWasReset,
            });
          } catch (error) {
            if (!isHostedShellLoadFailure(error)) {
              throw error;
            }

            write({
              type: "update",
              message: "Hosted shell load failed. Recreating container and retrying once.",
            });

            const resetState = await ensureTaskReady(taskId, { forceNewContainer: true });
            write({
              type: "update",
              message: `Recreated hosted container ${resetState.task.containerId}. Retrying run.`,
            });

            sandboxResult = await runSandboxedTask({
              sessionId: resetState.task.sessionId,
              containerId: resetState.task.containerId!,
              reset: true,
            });
          }

          assistantText =
            sandboxResult.finalOutput ||
            assistantDraft ||
            "Completed without a final text response.";
          responseId = sandboxResult.responseId;

          try {
            cachedArtifacts = await syncTaskArtifacts(taskId);
          } catch (error) {
            console.error("Artifact cache failed:", error);
            write({
              type: "update",
              message: "Artifact caching failed, but the task output was preserved.",
            });
          }
        } else {
          const standardResult = await streamKnowledgeTaskWithoutSandbox({
            taskId,
            agentId: agent.id,
            agentName: agent.name,
            sessionId: existingTask.sessionId,
            instructions: buildAgentInstructions(existingTask, agent, contextSet, {
              useHostedShell: false,
            }),
            prompt,
            traceId,
            onEvent(event) {
              if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
                assistantDraft += event.data.delta;
                write({ type: "assistant_delta", delta: event.data.delta });
              }
            },
          });

          assistantText =
            standardResult.finalOutput ||
            assistantDraft ||
            "Completed without a final text response.";
          responseId = standardResult.responseId;
          cachedArtifacts = [];
        }

        await updateTaskAfterRun({
          taskId,
          prompt,
          assistantText,
          responseId,
          traceId,
          runId,
          status: "completed",
          artifacts: cachedArtifacts,
        });

        write({
          type: "done",
          responseId,
          assistantText,
          artifacts: cachedArtifacts,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        let recoveredArtifacts = [] as Awaited<ReturnType<typeof syncTaskArtifacts>>;
        let failurePersisted = false;

        try {
          recoveredArtifacts = await syncTaskArtifacts(taskId);
          if (recoveredArtifacts.length) {
            write({
              type: "update",
              message: `Recovered ${recoveredArtifacts.length} downloadable files from the container after the run error.`,
            });
          }
        } catch (recoveryError) {
          console.error("Artifact recovery failed:", recoveryError);
        }

        try {
          await updateTaskAfterRun({
            taskId,
            prompt,
            assistantText: assistantDraft || `The run ended with an error: ${message}`,
            traceId,
            runId,
            status: "failed",
            artifacts: recoveredArtifacts,
          });
          failurePersisted = true;
        } catch (persistError) {
          console.error("Failed run persistence failed:", persistError);
        }

        try {
          if (!failurePersisted) {
            await setTaskStatus(taskId, "failed", { traceId });
          }
        } catch {
          // Best effort only.
        }

        write({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}
