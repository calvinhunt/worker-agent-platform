import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { suggestTaskTitle } from "@/lib/agents";
import { readStore, writeStore } from "@/lib/store";
import type { Task } from "@/lib/types";

export const runtime = "nodejs";

type CreateTaskBody = {
  name?: string;
  agentId?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as CreateTaskBody;
  const requestedName = String(body.name || "").trim();
  const agentId = String(body.agentId || "").trim();

  if (!agentId) {
    return NextResponse.json({ error: "Agent selection is required." }, { status: 400 });
  }

  const store = await readStore();
  const agent = store.agents.find((entry) => entry.id === agentId);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }

  const contextSet = store.contextSets.find((entry) => entry.id === agent.contextSetId);

  if (!contextSet) {
    return NextResponse.json({ error: "The agent context set was not found." }, { status: 404 });
  }

  const name =
    requestedName ||
    (await suggestTaskTitle({
      agentName: agent.name,
      instructions: agent.instructions,
      contextSetName: contextSet.name,
    }));

  const timestamp = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    agentId,
    name,
    messages: [],
    artifacts: [],
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.tasks.unshift(task);
  await writeStore(store);

  return NextResponse.json(task);
}
