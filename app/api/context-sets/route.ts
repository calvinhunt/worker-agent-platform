import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { readStore, writeStore } from "@/lib/store";
import { normalizeRelativePath } from "@/lib/tasks";
import type { ContextSet, StoredFile } from "@/lib/types";

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

  const contextSetId = randomUUID();
  const rootDir = path.join(process.cwd(), "data", "context-sets", contextSetId);
  const storedFiles: StoredFile[] = [];

  await mkdir(rootDir, { recursive: true });

  for (const file of incomingFiles) {
    const relativePath = normalizeRelativePath(file.name);
    const diskPath = path.join(rootDir, relativePath);

    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, Buffer.from(await file.arrayBuffer()));

    storedFiles.push({
      id: randomUUID(),
      name: path.basename(relativePath),
      relativePath,
      diskPath,
      size: file.size,
    });
  }

  const timestamp = new Date().toISOString();
  const contextSet: ContextSet = {
    id: contextSetId,
    name,
    files: storedFiles,
    openaiFileIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const store = await readStore();
  store.contextSets.unshift(contextSet);
  await writeStore(store);

  return NextResponse.json(contextSet);
}
