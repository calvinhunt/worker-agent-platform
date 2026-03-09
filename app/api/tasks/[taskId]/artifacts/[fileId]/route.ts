import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getOpenAIClient } from "@/lib/openai";
import { readStore } from "@/lib/store";
import { artifactFilename } from "@/lib/tasks";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ taskId: string; fileId: string }> },
) {
  const { taskId, fileId } = await context.params;
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);
  const artifact = task?.artifacts.find((entry) => entry.id === fileId);

  if (artifact?.localPath) {
    try {
      const fileBuffer = await readFile(artifact.localPath);

      return new Response(fileBuffer, {
        headers: {
          "Content-Disposition": `attachment; filename="${artifactFilename(artifact.path)}"`,
          "Content-Type": "application/octet-stream",
        },
      });
    } catch {
      // Fall through to the container copy.
    }
  }

  if (!task?.containerId) {
    return NextResponse.json({ error: "Task container not found." }, { status: 404 });
  }

  const client = getOpenAIClient();
  try {
    const [metadata, contentResponse] = await Promise.all([
      client.containers.files.retrieve(fileId, { container_id: task.containerId }),
      client.containers.files.content.retrieve(fileId, { container_id: task.containerId }),
    ]);

    const arrayBuffer = await contentResponse.arrayBuffer();

    return new Response(arrayBuffer, {
      headers: {
        "Content-Disposition": `attachment; filename="${artifactFilename(metadata.path)}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact download failed.";
    const status = message.includes("Container is expired") ? 410 : 500;

    return NextResponse.json(
      {
        error:
          status === 410
            ? "The hosted container has expired and this artifact was not cached locally. Re-run the task to regenerate it."
            : message,
      },
      { status },
    );
  }
}
