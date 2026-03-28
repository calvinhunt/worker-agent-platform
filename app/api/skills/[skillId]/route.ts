import { rm } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { buildUpdatedAdminSettings } from "@/lib/settings";
import { getManagedSkillsRoot, getSkillStorageRoot } from "@/lib/skills";
import { readStore, writeStore } from "@/lib/store";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ skillId: string }> },
) {
  const { skillId } = await context.params;
  const store = await readStore();
  const skill = store.skills.find((entry) => entry.id === skillId);

  if (!skill) {
    return NextResponse.json({ error: "Skill not found." }, { status: 404 });
  }

  store.skills = store.skills.filter((entry) => entry.id !== skillId);
  store.settings = buildUpdatedAdminSettings(
    store.settings,
    {
      baselineSkillIds: store.settings.baselineSkillIds.filter((entry) => entry !== skillId),
    },
    { validSkillIds: new Set(store.skills.map((entry) => entry.id)) },
  );
  store.agents = store.agents.map((agent) => ({
    ...agent,
    skillIds: agent.skillIds.filter((entry) => entry !== skillId),
    updatedAt: agent.skillIds.includes(skillId) ? new Date().toISOString() : agent.updatedAt,
  }));
  await writeStore(store);

  const managedRoot = path.resolve(getManagedSkillsRoot());
  const storageRoot = path.resolve(getSkillStorageRoot(skill));

  if (
    storageRoot === managedRoot ||
    storageRoot.startsWith(`${managedRoot}${path.sep}`)
  ) {
    await rm(storageRoot, { recursive: true, force: true });
  }

  return NextResponse.json({ deleted: true, id: skillId });
}
