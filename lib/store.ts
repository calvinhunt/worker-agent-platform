import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Agent, AppStore, Task } from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const EMPTY_STORE: AppStore = {
  agents: [],
  contextSets: [],
  skills: [],
  tasks: [],
};

type LegacyTask = Task & {
  instructions?: string;
  contextSetId?: string;
  skillIds?: string[];
  agentId?: string;
};

function normalizeStore(parsed: Partial<AppStore>) {
  const agents = [...(parsed.agents ?? [])];
  const tasks = (parsed.tasks ?? []).map((entry) => entry as LegacyTask);
  const agentIds = new Set(agents.map((agent) => agent.id));

  const normalizedTasks = tasks.map((task) => {
    const agentId = task.agentId || `legacy-agent-${task.id}`;

    if (!agentIds.has(agentId)) {
      const legacyAgent: Agent = {
        id: agentId || randomUUID(),
        name: task.name || "Migrated agent",
        instructions: task.instructions || "Migrated from the earlier task-first layout.",
        contextSetId: task.contextSetId || "",
        skillIds: task.skillIds ?? [],
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };

      agents.push(legacyAgent);
      agentIds.add(legacyAgent.id);
    }

    return {
      id: task.id,
      agentId,
      name: task.name,
      containerId: task.containerId,
      lastResponseId: task.lastResponseId,
      messages: task.messages ?? [],
      artifacts: task.artifacts ?? [],
      status: task.status ?? "idle",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    } satisfies Task;
  });

  return {
    agents,
    contextSets: parsed.contextSets ?? [],
    skills: parsed.skills ?? [],
    tasks: normalizedTasks,
  } satisfies AppStore;
}

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
    return normalizeStore(parsed);
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
