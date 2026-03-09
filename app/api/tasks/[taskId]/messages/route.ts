import { NextResponse } from "next/server";

import { getDefaultModel, getOpenAIClient } from "@/lib/openai";
import {
  buildAgentInstructions,
  cacheTaskArtifacts,
  ensureTaskReady,
  extractArtifactsFromResponse,
  listTaskArtifacts,
  mergeArtifacts,
  setTaskStatus,
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

      try {
        await setTaskStatus(taskId, "running");
        write({ type: "status", status: "running" });

        const { task, contextSet } = await ensureTaskReady(taskId);
        write({
          type: "update",
          message: task.containerId
            ? `Using container ${task.containerId}`
            : "Preparing hosted container",
        });

        const client = getOpenAIClient();
        const responseStream = client.responses.stream({
          model: getDefaultModel(),
          store: true,
          input: prompt,
          previous_response_id: task.lastResponseId,
          instructions: buildAgentInstructions(task, contextSet),
          tools: [
            {
              type: "shell",
              environment: {
                type: "container_reference",
                container_id: task.containerId!,
              },
            },
          ],
          text: {
            verbosity: "medium",
          },
        });

        for await (const event of responseStream) {
          switch (event.type) {
            case "response.output_text.delta":
              assistantDraft += event.delta;
              write({ type: "assistant_delta", delta: event.delta });
              break;
            case "response.output_item.added":
              if (event.item.type === "shell_call") {
                write({
                  type: "update",
                  message: `Running shell step: ${event.item.action.commands.join(" && ")}`,
                });
              }
              break;
            case "response.output_item.done":
              if (event.item.type === "shell_call_output") {
                const summary = summarizeShellOutput(event.item.output);
                if (summary) {
                  write({
                    type: "shell_output",
                    output: summary,
                  });
                }
              }
              break;
            case "response.completed":
              write({
                type: "update",
                message: "Model response completed. Gathering /mnt/data artifacts.",
              });
              break;
            case "response.failed":
              write({
                type: "error",
                message: event.response.error?.message || "The model response failed.",
              });
              break;
            default:
              break;
          }
        }

        const finalResponse = await responseStream.finalResponse();
        const assistantText =
          finalResponse.output_text || assistantDraft || "Completed without a final text response.";
        let artifacts = extractArtifactsFromResponse(finalResponse);

        try {
          const listedArtifacts = await listTaskArtifacts(taskId);
          artifacts = mergeArtifacts(artifacts, listedArtifacts);
        } catch (error) {
          console.error("Artifact list failed:", error);
          write({
            type: "update",
            message: "Artifact listing from the container failed; using response annotations instead.",
          });
        }

        let cachedArtifacts = artifacts;

        try {
          cachedArtifacts = await cacheTaskArtifacts(taskId, task.containerId!, artifacts);
        } catch (error) {
          console.error("Artifact cache failed:", error);
          write({
            type: "update",
            message: "Artifact caching failed, but the task output was preserved.",
          });
        }

        await updateTaskAfterRun({
          taskId,
          prompt,
          assistantText,
          responseId: finalResponse.id,
          status: "completed",
          artifacts: cachedArtifacts,
        });

        write({
          type: "done",
          responseId: finalResponse.id,
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
            status: "failed",
            artifacts: recoveredArtifacts,
          });
          failurePersisted = true;
        } catch (persistError) {
          console.error("Failed run persistence failed:", persistError);
        }

        try {
          if (!failurePersisted) {
            await setTaskStatus(taskId, "failed");
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
