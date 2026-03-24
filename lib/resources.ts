import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { slugifySkillName } from "@/lib/skills";
import { normalizeRelativePath } from "@/lib/tasks";
import type { ContextSet, SkillBundle, StoredFile } from "@/lib/types";

export async function createContextSetRecord(name: string, incomingFiles: File[]) {
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

  return {
    id: contextSetId,
    name,
    files: storedFiles,
    openaiFileIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies ContextSet;
}

export async function createSkillBundleRecord(uploadedFile: File, providedName?: string) {
  const skillId = randomUUID();
  const rootDir = path.join(process.cwd(), "data", "skills", skillId);
  const diskPath = path.join(rootDir, uploadedFile.name);
  const name = providedName || uploadedFile.name.replace(/\.zip$/i, "");

  await mkdir(rootDir, { recursive: true });
  await writeFile(diskPath, Buffer.from(await uploadedFile.arrayBuffer()));

  const timestamp = new Date().toISOString();

  return {
    id: skillId,
    name,
    description: "",
    slug: slugifySkillName(name),
    source: "uploaded",
    filename: uploadedFile.name,
    diskPath,
    format: "zip",
    files: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies SkillBundle;
}
