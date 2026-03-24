import { NextResponse } from "next/server";

import { createManualSkillRecord, listCuratedSkills } from "@/lib/skills";
import { readStore, writeStore } from "@/lib/store";

export const runtime = "nodejs";

type CreateSkillBody = {
  name?: string;
  description?: string;
  instructions?: string;
};

export async function GET() {
  const store = await readStore();

  try {
    const curatedSkills = await listCuratedSkills();

    return NextResponse.json({
      skills: store.skills,
      curatedSkills,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to load curated skills right now.";

    return NextResponse.json({
      skills: store.skills,
      curatedSkills: [],
      catalogError: message,
    });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as CreateSkillBody;
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const instructions = String(body.instructions || "").trim();

  if (!name) {
    return NextResponse.json({ error: "Skill name is required." }, { status: 400 });
  }

  if (!description) {
    return NextResponse.json(
      { error: "Skill description is required so the agent knows when to trigger it." },
      { status: 400 },
    );
  }

  if (!instructions) {
    return NextResponse.json({ error: "Skill instructions are required." }, { status: 400 });
  }

  const skill = await createManualSkillRecord({
    name,
    description,
    instructions,
  });

  const store = await readStore();
  store.skills.unshift(skill);
  await writeStore(store);

  return NextResponse.json(skill, { status: 201 });
}
