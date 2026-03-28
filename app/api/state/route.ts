import { NextResponse } from "next/server";

import { hasOpenAIKey } from "@/lib/openai";
import { readStore } from "@/lib/store";
import { filterDownloadableArtifacts, syncTaskArtifacts } from "@/lib/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let store = await readStore();
  const tasksNeedingRecovery = store.tasks.filter(
    (task) =>
      task.containerId &&
      task.status !== "running" &&
      (task.artifacts.length === 0 ||
        filterDownloadableArtifacts(task.artifacts).length !== task.artifacts.length),
  );

  for (const task of tasksNeedingRecovery) {
    try {
      await syncTaskArtifacts(task.id);
    } catch {
      // Best effort only. State should still load if artifact recovery fails.
    }
  }

  if (tasksNeedingRecovery.length) {
    store = await readStore();
  }

  return NextResponse.json({
    ...store,
    hasOpenAIKey: hasOpenAIKey(),
    model: store.settings.agentDefaults.model,
  });
}
