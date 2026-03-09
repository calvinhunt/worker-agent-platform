import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { readStore, writeStore } from "@/lib/store";
import type { SkillBundle } from "@/lib/types";

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

  const skillId = randomUUID();
  const rootDir = path.join(process.cwd(), "data", "skills", skillId);
  const diskPath = path.join(rootDir, uploadedFile.name);

  await mkdir(rootDir, { recursive: true });
  await writeFile(diskPath, Buffer.from(await uploadedFile.arrayBuffer()));

  const timestamp = new Date().toISOString();
  const skill: SkillBundle = {
    id: skillId,
    name: providedName || uploadedFile.name.replace(/\.zip$/i, ""),
    filename: uploadedFile.name,
    diskPath,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const store = await readStore();
  store.skills.unshift(skill);
  await writeStore(store);

  return NextResponse.json(skill);
}
