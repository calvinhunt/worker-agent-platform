import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppStore } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const EMPTY_STORE: AppStore = {
  contextSets: [],
  skills: [],
  tasks: [],
};

async function ensureStoreFile() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(STORE_PATH, "utf8");
  } catch {
    await writeFile(STORE_PATH, JSON.stringify(EMPTY_STORE, null, 2), "utf8");
  }
}

export async function readStore(): Promise<AppStore> {
  await ensureStoreFile();
  const raw = await readFile(STORE_PATH, "utf8");

  try {
    const parsed = JSON.parse(raw) as Partial<AppStore>;

    return {
      contextSets: parsed.contextSets ?? [],
      skills: parsed.skills ?? [],
      tasks: parsed.tasks ?? [],
    };
  } catch {
    return EMPTY_STORE;
  }
}

export async function writeStore(store: AppStore) {
  await ensureStoreFile();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function updateStore(
  updater: (store: AppStore) => AppStore | Promise<AppStore>,
) {
  const current = await readStore();
  const next = await updater(current);
  await writeStore(next);

  return next;
}
