import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentInputItem, Session } from "@openai/agents";

type PersistedTaskSession = {
  sessionId: string;
  items: AgentInputItem[];
  updatedAt: string;
};

const TASK_SESSION_DIR = path.join(process.cwd(), "data", "task-sessions");

function emptySession(sessionId: string): PersistedTaskSession {
  return {
    sessionId,
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

export function getTaskSessionPath(sessionId: string) {
  return path.join(TASK_SESSION_DIR, `${sessionId}.json`);
}

async function readPersistedTaskSession(sessionId: string) {
  const sessionPath = getTaskSessionPath(sessionId);
  await mkdir(TASK_SESSION_DIR, { recursive: true });

  try {
    const raw = await readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedTaskSession>;

    return {
      sessionId,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    } satisfies PersistedTaskSession;
  } catch {
    return emptySession(sessionId);
  }
}

async function writePersistedTaskSession(
  sessionId: string,
  items: AgentInputItem[],
) {
  const sessionPath = getTaskSessionPath(sessionId);
  const payload: PersistedTaskSession = {
    sessionId,
    items,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(TASK_SESSION_DIR, { recursive: true });
  await writeFile(sessionPath, JSON.stringify(payload, null, 2), "utf8");
}

export class FileTaskSession implements Session {
  constructor(private readonly sessionId: string) {}

  async getSessionId() {
    return this.sessionId;
  }

  async getItems(limit?: number) {
    const session = await readPersistedTaskSession(this.sessionId);
    if (typeof limit === "number") {
      return session.items.slice(-limit);
    }

    return session.items;
  }

  async addItems(items: AgentInputItem[]) {
    const session = await readPersistedTaskSession(this.sessionId);
    await writePersistedTaskSession(this.sessionId, [...session.items, ...items]);
  }

  async popItem() {
    const session = await readPersistedTaskSession(this.sessionId);
    const item = session.items.at(-1);

    if (!item) {
      return undefined;
    }

    await writePersistedTaskSession(this.sessionId, session.items.slice(0, -1));
    return item;
  }

  async clearSession() {
    await writePersistedTaskSession(this.sessionId, []);
  }
}
