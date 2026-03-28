import { NextResponse } from "next/server";

import { buildUpdatedAdminSettings } from "@/lib/settings";
import { readStore, writeStore } from "@/lib/store";
import type { AdminSettings } from "@/lib/types";

export const runtime = "nodejs";

type UpdateAdminSettingsBody = Partial<AdminSettings>;

export async function GET() {
  const store = await readStore();
  return NextResponse.json(store.settings);
}

export async function POST(request: Request) {
  const body = (await request.json()) as UpdateAdminSettingsBody;
  const store = await readStore();
  const validSkillIds = new Set(store.skills.map((skill) => skill.id));

  store.settings = buildUpdatedAdminSettings(store.settings, body, { validSkillIds });
  await writeStore(store);

  return NextResponse.json(store.settings);
}
