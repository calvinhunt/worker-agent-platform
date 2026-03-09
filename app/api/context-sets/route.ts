import { NextResponse } from "next/server";

import { createContextSetRecord } from "@/lib/resources";
import { readStore, writeStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const name = String(formData.get("name") || "").trim();
  const incomingFiles = formData.getAll("files").filter((entry): entry is File => entry instanceof File);

  if (!name) {
    return NextResponse.json({ error: "Context set name is required." }, { status: 400 });
  }

  if (!incomingFiles.length) {
    return NextResponse.json({ error: "Upload at least one file or folder." }, { status: 400 });
  }

  const contextSet = await createContextSetRecord(name, incomingFiles);
  const store = await readStore();
  store.contextSets.unshift(contextSet);
  await writeStore(store);

  return NextResponse.json(contextSet);
}
