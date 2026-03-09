import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { suggestAgentTitle } from "@/lib/agents";
import { createContextSetRecord, createSkillBundleRecord } from "@/lib/resources";
import { readStore, writeStore } from "@/lib/store";
import type { Agent, SkillBundle } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const requestedName = String(formData.get("name") || "").trim();
  const instructions = String(formData.get("instructions") || "").trim();
  const contextSetName = String(formData.get("contextSetName") || "").trim();
  const selectedSkillIds = JSON.parse(String(formData.get("selectedSkillIds") || "[]")) as string[];
  const contextFiles = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  const newSkillFiles = formData.getAll("skillFiles").filter((entry): entry is File => entry instanceof File);

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
  const selectedSkills = store.skills.filter((skill) => selectedSkillIds.includes(skill.id));

  if (selectedSkills.length !== selectedSkillIds.length) {
    return NextResponse.json({ error: "One or more selected skills were not found." }, { status: 404 });
  }

  const invalidSkillBundle = newSkillFiles.find((file) => !file.name.toLowerCase().endsWith(".zip"));

  if (invalidSkillBundle) {
    return NextResponse.json(
      { error: "Upload skill bundles as .zip files that contain SKILL.md and related assets." },
      { status: 400 },
    );
  }

  const contextSet = await createContextSetRecord(contextSetName, contextFiles);
  const createdSkills: SkillBundle[] = [];

  for (const file of newSkillFiles) {
    createdSkills.push(await createSkillBundleRecord(file));
  }

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
    skillIds: [...selectedSkills.map((skill) => skill.id), ...createdSkills.map((skill) => skill.id)],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  store.contextSets.unshift(contextSet);
  store.skills.unshift(...createdSkills);
  store.agents.unshift(agent);
  await writeStore(store);

  return NextResponse.json({ agent, contextSet, createdSkills });
}
