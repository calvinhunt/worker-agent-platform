import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { hasOpenAIKey, getOpenAIClient } from "@/lib/openai";
import { readStore, writeStore } from "@/lib/store";

const DATA_DIR = path.join(process.cwd(), "data");
const MAINTENANCE_STATE_PATH = path.join(DATA_DIR, "maintenance.json");
const TASK_ARTIFACTS_DIR = path.join(DATA_DIR, "task-artifacts");
const TASK_SESSIONS_DIR = path.join(DATA_DIR, "task-sessions");
const CONTEXT_SETS_DIR = path.join(DATA_DIR, "context-sets");
const SKILLS_DIR = path.join(DATA_DIR, "skills");

const DEFAULT_MAINTENANCE_INTERVAL_MINUTES = 30;
const DEFAULT_TASK_INACTIVITY_HOURS = 72;
const DEFAULT_ORPHAN_RETENTION_HOURS = 24;

type MaintenanceState = {
  lastRunAt?: string;
};

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaintenanceIntervalMs() {
  const minutes = parsePositiveInteger(
    process.env.MAINTENANCE_INTERVAL_MINUTES,
    DEFAULT_MAINTENANCE_INTERVAL_MINUTES,
  );
  return minutes * 60 * 1_000;
}

function getTaskInactivityMs() {
  const hours = parsePositiveInteger(
    process.env.TASK_INACTIVITY_HOURS,
    DEFAULT_TASK_INACTIVITY_HOURS,
  );
  return hours * 60 * 60 * 1_000;
}

function getOrphanRetentionMs() {
  const hours = parsePositiveInteger(
    process.env.MAINTENANCE_ORPHAN_RETENTION_HOURS,
    DEFAULT_ORPHAN_RETENTION_HOURS,
  );
  return hours * 60 * 60 * 1_000;
}

async function readMaintenanceState() {
  try {
    const raw = await readFile(MAINTENANCE_STATE_PATH, "utf8");
    return JSON.parse(raw) as MaintenanceState;
  } catch {
    return {} satisfies MaintenanceState;
  }
}

async function writeMaintenanceState(nextState: MaintenanceState) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(MAINTENANCE_STATE_PATH, JSON.stringify(nextState, null, 2), "utf8");
}

function parseDateMs(value: string | undefined) {
  if (!value) {
    return Number.NaN;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

async function deleteIfExists(targetPath: string) {
  try {
    await rm(targetPath, { force: true, recursive: true });
  } catch {
    // Best effort cleanup.
  }
}

async function listEntriesSafe(dirPath: string) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function cleanupOrphanDirectories(options: {
  rootDir: string;
  validNames: Set<string>;
  olderThanMs: number;
  nowMs: number;
}) {
  const entries = await listEntriesSafe(options.rootDir);

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !options.validNames.has(entry.name))
      .map(async (entry) => {
        const targetPath = path.join(options.rootDir, entry.name);

        try {
          const metadata = await stat(targetPath);
          const ageMs = options.nowMs - metadata.mtimeMs;

          if (ageMs >= options.olderThanMs) {
            await deleteIfExists(targetPath);
          }
        } catch {
          // Ignore missing paths and other transient file errors.
        }
      }),
  );
}

export async function runPeriodicMaintenance() {
  const now = new Date();
  const nowMs = now.getTime();
  const state = await readMaintenanceState();
  const lastRunMs = parseDateMs(state.lastRunAt);

  if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < getMaintenanceIntervalMs()) {
    return { ran: false };
  }

  const store = await readStore();
  const staleThresholdMs = getTaskInactivityMs();
  const staleTaskIds = new Set<string>();
  const staleSessionIds = new Set<string>();
  const staleContainerIds: string[] = [];

  for (const task of store.tasks) {
    if (task.status === "running") {
      continue;
    }

    const updatedAtMs = parseDateMs(task.updatedAt);

    if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs < staleThresholdMs) {
      continue;
    }

    staleTaskIds.add(task.id);
    staleSessionIds.add(task.sessionId);

    if (task.containerId) {
      staleContainerIds.push(task.containerId);
      task.containerId = undefined;
    }

    task.artifacts = [];
  }

  if (hasOpenAIKey() && staleContainerIds.length) {
    const client = getOpenAIClient();

    await Promise.all(
      staleContainerIds.map(async (containerId) => {
        try {
          await client.containers.delete(containerId);
        } catch {
          // Container may already be expired/deleted.
        }
      }),
    );
  }

  await Promise.all(
    Array.from(staleTaskIds).map((taskId) =>
      deleteIfExists(path.join(TASK_ARTIFACTS_DIR, taskId)),
    ),
  );

  await Promise.all(
    Array.from(staleSessionIds).map((sessionId) =>
      deleteIfExists(path.join(TASK_SESSIONS_DIR, `${sessionId}.json`)),
    ),
  );

  const activeTaskIds = new Set(store.tasks.map((task) => task.id));
  const activeSessionIds = new Set(store.tasks.map((task) => `${task.sessionId}.json`));
  const activeContextSetIds = new Set(store.contextSets.map((contextSet) => contextSet.id));
  const activeSkillIds = new Set(store.skills.map((skill) => skill.id));
  const orphanRetentionMs = getOrphanRetentionMs();

  await Promise.all([
    cleanupOrphanDirectories({
      rootDir: TASK_ARTIFACTS_DIR,
      validNames: activeTaskIds,
      olderThanMs: orphanRetentionMs,
      nowMs,
    }),
    cleanupOrphanDirectories({
      rootDir: CONTEXT_SETS_DIR,
      validNames: activeContextSetIds,
      olderThanMs: orphanRetentionMs,
      nowMs,
    }),
    cleanupOrphanDirectories({
      rootDir: SKILLS_DIR,
      validNames: activeSkillIds,
      olderThanMs: orphanRetentionMs,
      nowMs,
    }),
  ]);

  const sessionEntries = await listEntriesSafe(TASK_SESSIONS_DIR);
  await Promise.all(
    sessionEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !activeSessionIds.has(entry.name))
      .map(async (entry) => {
        const filePath = path.join(TASK_SESSIONS_DIR, entry.name);

        try {
          const metadata = await stat(filePath);
          const ageMs = nowMs - metadata.mtimeMs;

          if (ageMs >= orphanRetentionMs) {
            await deleteIfExists(filePath);
          }
        } catch {
          // Best effort only.
        }
      }),
  );

  if (staleTaskIds.size > 0) {
    await writeStore(store);
  }

  await writeMaintenanceState({ lastRunAt: now.toISOString() });

  return {
    ran: true,
    staleTasksCleaned: staleTaskIds.size,
    staleContainersDeleted: staleContainerIds.length,
  };
}
