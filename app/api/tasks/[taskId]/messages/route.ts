import { NextResponse } from "next/server";

import { generateTraceId } from "@openai/agents";

import { parseActivityMarker, stripActivityMarkers, summarizeCommand } from "@/lib/activity";
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
      let pendingAssistantLine = "";
      let runId: string | undefined;
      const traceId = generateTraceId();

      const emitAssistantText = (text: string) => {
        if (!text) {
          return;
        }

        assistantDraft += text;
        write({ type: "assistant_delta", delta: text });
      };

      const handleAssistantLine = (line: string) => {
        const activity = parseActivityMarker(line);

        if (!activity) {
          emitAssistantText(`${line}\n`);
          return;
        }

        if (activity.kind === "skill") {
          write({
            type: "skill_use",
            skillName: activity.name,
            message: activity.message || `Activated ${activity.name}.`,
          });
          return;
        }

        write({
          type: "work_summary",
          message: activity.message,
        });
      };

      const ingestAssistantDelta = (delta: string) => {
        pendingAssistantLine += delta;
        const lines = pendingAssistantLine.split(/\r?\n/);
        pendingAssistantLine = lines.pop() ?? "";

        for (const line of lines) {
          handleAssistantLine(line);
        }
      };

      const flushAssistantDelta = () => {
        if (!pendingAssistantLine) {
          return;
        }

        const activity = parseActivityMarker(pendingAssistantLine);

        if (activity?.kind === "skill") {
          write({
            type: "skill_use",
            skillName: activity.name,
            message: activity.message || `Activated ${activity.name}.`,
          });
        } else if (activity?.kind === "summary") {
          write({
            type: "work_summary",
            message: activity.message,
          });
        } else {
          emitAssistantText(pendingAssistantLine);
        }

        pendingAssistantLine = "";
      };

      const finalizeAssistantText = (finalOutput?: string) => {
        flushAssistantDelta();
        const visibleFinalOutput = stripActivityMarkers(finalOutput || assistantDraft).trim();
        return visibleFinalOutput || assistantDraft.trim() || "Completed without a final text response.";
      };

      try {
        const { run } = await startTaskRun(taskId, { traceId });
        runId = run.id;
        write({ type: "status", status: "running" });

        write({
          type: "work_summary",
          message: "Reviewing the task, context files, and available skills.",
        });

        const { task: existingTask, agent, contextSet, skills: selectedSkills } =
          await getTaskContext(taskId);
        const triage = await triageSandboxNeed({
          prompt,
          agentName: agent.name,
          agentInstructions: agent.instructions,
          contextSetName: contextSet.name,
        });
        const shouldUseSandbox = triage.category === "sandbox";

        write({
          type: "work_summary",
          message: shouldUseSandbox
            ? "Routing this task to hosted shell mode."
            : "Handling this task in standard mode without hosted shell access.",
        });

        let responseId: string | undefined;
        let assistantText = "";
        let cachedArtifacts = existingTask.artifacts;

        if (shouldUseSandbox) {
          const runSandboxedTask = async (readyState: Awaited<ReturnType<typeof ensureTaskReady>>) =>
            streamKnowledgeTask({
              taskId,
              agentId: agent.id,
              agentName: agent.name,
              sessionId: readyState.task.sessionId,
              containerId: readyState.task.containerId!,
              instructions: buildAgentInstructions(readyState.task, agent, contextSet, readyState.skills, {
                containerWasReset: readyState.containerWasReset,
              }),
              prompt,
              traceId,
              onEvent(event) {
                if (event.type === "raw_model_stream_event") {
                  switch (event.data.type) {
                    case "output_text_delta":
                      ingestAssistantDelta(event.data.delta);
                      break;
                    case "response_done":
                      flushAssistantDelta();
                      write({
                        type: "work_summary",
                        message: "Finalizing the response and collecting generated files.",
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
                      type: "tool_use",
                      toolName: "shell",
                      message: summarizeCommand(event.item.rawItem.action.commands),
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

          let readyState = await ensureTaskReady(taskId);

          if (readyState.containerWasCreated || readyState.containerWasReset) {
            write({
              type: "work_summary",
              message: "Preparing the hosted workspace for this run.",
            });
          }

          let sandboxResult: Awaited<ReturnType<typeof streamKnowledgeTask>>;
          try {
            sandboxResult = await runSandboxedTask(readyState);
          } catch (error) {
            if (!isHostedShellLoadFailure(error)) {
              throw error;
            }

            write({
              type: "work_summary",
              message: "Hosted shell load failed. Recreating the workspace and retrying once.",
            });

            readyState = await ensureTaskReady(taskId, { forceNewContainer: true });
            write({
              type: "work_summary",
              message: "Retrying in a fresh hosted workspace.",
            });
            sandboxResult = await runSandboxedTask(readyState);
          }

          assistantText = finalizeAssistantText(sandboxResult.finalOutput);
          responseId = sandboxResult.responseId;

          try {
            cachedArtifacts = await syncTaskArtifacts(taskId);
          } catch (error) {
            console.error("Artifact cache failed:", error);
            write({
              type: "work_summary",
              message: "Artifact caching failed, but the task output was preserved.",
            });
          }
        } else {
          const standardResult = await streamKnowledgeTaskWithoutSandbox({
            taskId,
            agentId: agent.id,
            agentName: agent.name,
            sessionId: existingTask.sessionId,
            instructions: buildAgentInstructions(existingTask, agent, contextSet, selectedSkills, {
              useHostedShell: false,
            }),
            prompt,
            traceId,
            onEvent(event) {
              if (event.type !== "raw_model_stream_event") {
                return;
              }

              switch (event.data.type) {
                case "output_text_delta":
                  ingestAssistantDelta(event.data.delta);
                  break;
                case "response_done":
                  flushAssistantDelta();
                  write({
                    type: "work_summary",
                    message: "Finalizing the response.",
                  });
                  break;
                default:
                  break;
              }
            },
          });

          assistantText = finalizeAssistantText(standardResult.finalOutput);
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
              type: "work_summary",
              message: `Recovered ${recoveredArtifacts.length} downloadable files after the run error.`,
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
