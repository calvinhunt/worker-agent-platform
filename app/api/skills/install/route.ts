import { NextResponse } from "next/server";

import { installCuratedSkillRecord } from "@/lib/skills";
import { readStore, writeStore } from "@/lib/store";

export const runtime = "nodejs";

type InstallSkillBody = {
  slug?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as InstallSkillBody;
  const slug = String(body.slug || "").trim();

  if (!slug) {
    return NextResponse.json({ error: "Curated skill slug is required." }, { status: 400 });
  }

  const store = await readStore();
  const existing = store.skills.find(
    (skill) => skill.source === "curated" && skill.slug === slug,
  );

  if (existing) {
    return NextResponse.json(existing);
  }

  try {
    const skill = await installCuratedSkillRecord(slug);
    store.skills.unshift(skill);
    await writeStore(store);

    return NextResponse.json(skill, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to install the curated skill.";

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
