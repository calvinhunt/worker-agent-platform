import { NextResponse } from "next/server";

import { createSkillBundleRecord } from "@/lib/resources";
import { readStore, writeStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const uploadedFile = formData.get("file");
  const providedName = String(formData.get("name") || "").trim();

  if (!(uploadedFile instanceof File)) {
    return NextResponse.json({ error: "Skill bundle file is required." }, { status: 400 });
  }

  if (!uploadedFile.name.toLowerCase().endsWith(".zip")) {
    return NextResponse.json(
      { error: "Upload a .zip bundle that contains SKILL.md and related assets." },
      { status: 400 },
    );
  }

  const skill = await createSkillBundleRecord(uploadedFile, providedName);
  const store = await readStore();
  store.skills.unshift(skill);
  await writeStore(store);

  return NextResponse.json(skill);
}
