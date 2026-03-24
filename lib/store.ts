import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { slugifySkillName } from "@/lib/skills";
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
  sessionId?: string;
  lastTraceId?: string;
  runs?: Task["runs"];
};

function normalizeStore(parsed: Partial<AppStore>) {
  const agents = [...(parsed.agents ?? [])];
  const tasks = (parsed.tasks ?? []).map((entry) => entry as LegacyTask);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const skills = (parsed.skills ?? []).map((entry) => {
    const timestamp = new Date().toISOString();
    const diskPath = typeof entry.diskPath === "string" ? entry.diskPath : "";
    const filename =
      typeof entry.filename === "string" && entry.filename
        ? entry.filename
        : path.basename(diskPath) || "skill.zip";

    return {
      id: typeof entry.id === "string" ? entry.id : randomUUID(),
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name
          : "Imported skill",
      description: typeof entry.description === "string" ? entry.description : "",
      slug:
        typeof entry.slug === "string" && entry.slug.trim()
          ? entry.slug
          : slugifySkillName(typeof entry.name === "string" ? entry.name : filename),
      source:
        entry.source === "manual" || entry.source === "curated" || entry.source === "uploaded"
          ? entry.source
          : "uploaded",
      filename,
      diskPath,
      format:
        entry.format === "directory" || entry.format === "zip"
          ? entry.format
          : filename.toLowerCase().endsWith(".zip")
            ? "zip"
            : "directory",
      files: Array.isArray(entry.files) ? entry.files : [],
      openaiSkillId:
        typeof entry.openaiSkillId === "string" ? entry.openaiSkillId : undefined,
      defaultVersion:
        typeof entry.defaultVersion === "string" ? entry.defaultVersion : undefined,
      originUrl: typeof entry.originUrl === "string" ? entry.originUrl : undefined,
      createdAt:
        typeof entry.createdAt === "string" ? entry.createdAt : timestamp,
      updatedAt:
        typeof entry.updatedAt === "string" ? entry.updatedAt : timestamp,
    };
  });

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
      sessionId: task.sessionId || task.id,
      lastResponseId: task.lastResponseId,
      lastTraceId: task.lastTraceId,
      messages: task.messages ?? [],
      artifacts: task.artifacts ?? [],
      runs: task.runs ?? [],
      status: task.status ?? "idle",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    } satisfies Task;
  });

  return {
    agents,
    contextSets: parsed.contextSets ?? [],
    skills,
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
