import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { suggestAgentTitle } from "@/lib/agents";
import { createContextSetRecord } from "@/lib/resources";
import { readStore, writeStore } from "@/lib/store";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const requestedName = String(formData.get("name") || "").trim();
  const instructions = String(formData.get("instructions") || "").trim();
  const contextSetName = String(formData.get("contextSetName") || "").trim();
  const selectedSkillIds = Array.from(
    new Set(JSON.parse(String(formData.get("selectedSkillIds") || "[]")) as string[]),
  );
  const contextFiles = formData.getAll("files").filter((entry): entry is File => entry instanceof File);

  if (!instructions) {
    return NextResponse.json({ error: "Agent instructions are required." }, { status: 400 });
  }

  if (!contextSetName) {
    return NextResponse.json({ error: "Context set name is required." }, { status: 400 });
  }

  if (!contextFiles.length) {
    return NextResponse.json({ error: "Upload at least one context file or folder." }, { status: 400 });
  }

  const store = await readStore();
  const requestedAgentSkillIds = selectedSkillIds.filter(
    (skillId) => !store.settings.baselineSkillIds.includes(skillId),
  );
  const selectedSkills = store.skills.filter((skill) => requestedAgentSkillIds.includes(skill.id));

  if (selectedSkills.length !== requestedAgentSkillIds.length) {
    return NextResponse.json({ error: "One or more selected skills were not found." }, { status: 404 });
  }

  const contextSet = await createContextSetRecord(contextSetName, contextFiles);

  const name =
    requestedName ||
    (await suggestAgentTitle({
      instructions,
      contextSetName,
    }));

  const timestamp = new Date().toISOString();
  const agent: Agent = {
    id: randomUUID(),
    name,
    instructions,
    contextSetId: contextSet.id,
    skillIds: selectedSkills.map((skill) => skill.id),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.contextSets.unshift(contextSet);
  store.agents.unshift(agent);
  await writeStore(store);

  return NextResponse.json({ agent, contextSet });
}
