import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { suggestTaskTitle } from "@/lib/agents";
import { readStore, writeStore } from "@/lib/store";
import type { Task } from "@/lib/types";

export const runtime = "nodejs";

type CreateTaskBody = {
  name?: string;
  instructions?: string;
  contextSetId?: string;
  skillIds?: string[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as CreateTaskBody;
  const instructions = String(body.instructions || "").trim();
  const contextSetId = String(body.contextSetId || "").trim();
  const requestedName = String(body.name || "").trim();
  const skillIds = (body.skillIds || []).map((entry) => String(entry));

  if (!instructions) {
    return NextResponse.json({ error: "Agent instructions are required." }, { status: 400 });
  }

  if (!contextSetId) {
    return NextResponse.json({ error: "Context set selection is required." }, { status: 400 });
  }

  const store = await readStore();
  const contextSet = store.contextSets.find((entry) => entry.id === contextSetId);

  if (!contextSet) {
    return NextResponse.json({ error: "Context set not found." }, { status: 404 });
  }

  const name =
    requestedName ||
    (await suggestTaskTitle({
      instructions,
      contextSetName: contextSet.name,
    }));

  const timestamp = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    name,
    instructions,
    contextSetId,
    skillIds,
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
