import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, posix as posixPath } from "node:path";
import path from "node:path";

import { toFile } from "openai";

import { createOpenAISkill } from "@/lib/skills";
import { getOpenAIClient } from "@/lib/openai";
import { getEffectiveAgentSkillIds } from "@/lib/settings";
import { readStore, writeStore } from "@/lib/store";
import type {
  Agent,
  ContextSet,
  SkillBundle,
  Task,
  TaskArtifact,
  TaskMessage,
  TaskRun,
  TaskStatus,
} from "@/lib/types";

function nowIso() {
  return new Date().toISOString();
}

export function normalizeRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const safe = posixPath.normalize(normalized);

  if (!safe || safe === "." || safe === ".." || safe.startsWith("../")) {
    throw new Error(`Unsafe relative path: ${value}`);
  }

  return safe;
}

export async function ensureTaskReady(
  taskId: string,
  options?: { forceNewContainer?: boolean },
) {
  const client = getOpenAIClient();
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task) {
    throw new Error("Task not found.");
  }

  const agent = store.agents.find((entry) => entry.id === task.agentId);

  if (!agent) {
    throw new Error("Agent not found.");
  }

  const contextSet = store.contextSets.find((entry) => entry.id === agent.contextSetId);

  if (!contextSet) {
    throw new Error("Context set not found.");
  }

  const effectiveSkillIds = new Set(getEffectiveAgentSkillIds(agent, store.settings));
  const skills = store.skills.filter((entry) => effectiveSkillIds.has(entry.id));

  if (contextSet.openaiFileIds.length !== contextSet.files.length) {
    const uploadedFileIds: string[] = [];

    for (const file of contextSet.files) {
      const upload = await client.files.create({
        file: await toFile(createReadStream(file.diskPath), file.relativePath),
        purpose: "user_data",
      });
      uploadedFileIds.push(upload.id);
    }

    contextSet.openaiFileIds = uploadedFileIds;
    contextSet.updatedAt = nowIso();
  }

  for (const skill of skills) {
    if (skill.openaiSkillId) {
      continue;
    }

    const createdSkill = await createOpenAISkill(skill);

    skill.openaiSkillId = createdSkill.id;
    skill.defaultVersion = createdSkill.default_version;
    skill.updatedAt = nowIso();
  }

  const existingContainerId = task.containerId;
  let containerWasReset = false;

  if (options?.forceNewContainer && task.containerId) {
    task.containerId = undefined;
    containerWasReset = true;
  } else if (task.containerId) {
    try {
      await client.containers.retrieve(task.containerId);
    } catch {
      task.containerId = undefined;
      containerWasReset = true;
    }
  }

  if (!task.containerId) {
    const containerDefaults = store.settings.containerDefaults;
    const createdContainer = await client.containers.create({
      name: task.name,
      expires_after: {
        anchor: "last_active_at",
        minutes: containerDefaults.expiresAfterMinutes,
      },
      file_ids: contextSet.openaiFileIds,
      memory_limit: containerDefaults.memoryLimit ?? undefined,
      network_policy:
        containerDefaults.networkPolicy.type === "allowlist"
          ? {
              type: "allowlist",
              allowed_domains: containerDefaults.networkPolicy.allowedDomains,
            }
          : {
              type: "disabled",
            },
      skills: skills.flatMap((skill) =>
        skill.openaiSkillId
          ? [
              {
                type: "skill_reference" as const,
                skill_id: skill.openaiSkillId,
              },
            ]
          : [],
      ),
    });

    task.containerId = createdContainer.id;
    task.updatedAt = nowIso();
  }

  await writeStore(store);

  return {
    agent,
    task,
    contextSet,
    skills,
    settings: store.settings,
    containerWasCreated: task.containerId !== existingContainerId,
    containerWasReset,
  };
}

export async function getTaskContext(taskId: string) {
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task) {
    throw new Error("Task not found.");
  }

  const agent = store.agents.find((entry) => entry.id === task.agentId);
  if (!agent) {
    throw new Error("Agent not found.");
  }

  const contextSet = store.contextSets.find((entry) => entry.id === agent.contextSetId);
  if (!contextSet) {
    throw new Error("Context set not found.");
  }

  const effectiveSkillIds = new Set(getEffectiveAgentSkillIds(agent, store.settings));
  const skills = store.skills.filter((entry) => effectiveSkillIds.has(entry.id));

  return {
    task,
    agent,
    contextSet,
    skills,
    settings: store.settings,
  };
}

export async function listTaskArtifacts(taskId: string) {
  const client = getOpenAIClient();
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task?.containerId) {
    return [];
  }

  const page = await client.containers.files.list(task.containerId, { order: "asc" });

  const files = page.data.filter((file) => isDownloadableContainerArtifact(file.path, file.source));

  return Promise.all(
    files.map(async (file) => {
      let bytes: number | null = file.bytes ?? null;

      // Some assistant-created container files come back with null size metadata in list results.
      // When that happens, fetch the content once and derive the byte size directly.
      if (bytes == null) {
        try {
          const content = await client.containers.files.content.retrieve(file.id, {
            container_id: task.containerId!,
          });
          const buffer = await content.arrayBuffer();
          bytes = buffer.byteLength;
        } catch {
          bytes = null;
        }
      }

      return {
        id: file.id,
        path: file.path,
        bytes,
        createdAt: file.created_at,
        source: file.source,
      } satisfies TaskArtifact;
    }),
  );
}

export function extractArtifactsFromResponse(response: {
  created_at?: number;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      annotations?: Array<{
        type?: string;
        container_id?: string;
        file_id?: string;
        filename?: string;
      }>;
    }>;
  }>;
}) {
  const artifacts = new Map<string, TaskArtifact>();

  for (const item of response.output ?? []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (content.type !== "output_text") {
        continue;
      }

      for (const annotation of content.annotations ?? []) {
        if (
          annotation.type !== "container_file_citation" ||
          !annotation.file_id ||
          !annotation.filename
        ) {
          continue;
        }

        artifacts.set(annotation.file_id, {
          id: annotation.file_id,
          path: `/mnt/data/${annotation.filename}`,
          bytes: null,
          createdAt: response.created_at ?? 0,
          source: "assistant",
        });
      }
    }
  }

  return Array.from(artifacts.values());
}

export function mergeArtifacts(primary: TaskArtifact[], secondary: TaskArtifact[]) {
  const merged = new Map<string, TaskArtifact>();

  for (const artifact of [...secondary, ...primary]) {
    const current = merged.get(artifact.id);
    merged.set(artifact.id, {
      ...current,
      ...artifact,
      bytes: artifact.bytes ?? current?.bytes ?? null,
      localPath: artifact.localPath ?? current?.localPath,
    });
  }

  return Array.from(merged.values());
}

export function filterDownloadableArtifacts(artifacts: TaskArtifact[]) {
  return artifacts.filter((artifact) => isDownloadableContainerArtifact(artifact.path, artifact.source));
}

function isDownloadableContainerArtifact(pathname: string, source: string) {
  return pathname.startsWith("/mnt/data/") && source !== "user";
}

export async function cacheTaskArtifacts(taskId: string, containerId: string, artifacts: TaskArtifact[]) {
  const client = getOpenAIClient();
  const artifactDir = path.join(process.cwd(), "data", "task-artifacts", taskId);

  await mkdir(artifactDir, { recursive: true });

  return Promise.all(
    artifacts.map(async (artifact) => {
      try {
        const content = await client.containers.files.content.retrieve(artifact.id, {
          container_id: containerId,
        });
        const buffer = Buffer.from(await content.arrayBuffer());
        const filename = `${artifact.id}-${artifactFilename(artifact.path)}`;
        const localPath = path.join(artifactDir, filename);

        await writeFile(localPath, buffer);

        return {
          ...artifact,
          bytes: artifact.bytes ?? buffer.byteLength,
          localPath,
        } satisfies TaskArtifact;
      } catch {
        return artifact;
      }
    }),
  );
}

export async function syncTaskArtifacts(taskId: string, seedArtifacts: TaskArtifact[] = []) {
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task?.containerId) {
    return [];
  }

  let artifacts = filterDownloadableArtifacts(mergeArtifacts(seedArtifacts, task.artifacts));

  try {
    const listedArtifacts = await listTaskArtifacts(taskId);
    artifacts = filterDownloadableArtifacts(mergeArtifacts(listedArtifacts, artifacts));
  } catch {
    // Best effort only. The task may still have useful artifacts from response annotations.
  }

  try {
    artifacts = await cacheTaskArtifacts(taskId, task.containerId, artifacts);
  } catch {
    // Best effort only. Keep artifact metadata even if local caching fails.
  }

  task.artifacts = artifacts;
  task.updatedAt = nowIso();
  await writeStore(store);

  return artifacts;
}

export async function updateTaskAfterRun(input: {
  taskId: string;
  prompt: string;
  assistantText: string;
  responseId?: string;
  traceId?: string;
  runId?: string;
  status: TaskStatus;
  artifacts: TaskArtifact[];
}) {
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === input.taskId);

  if (!task) {
    throw new Error("Task not found.");
  }

  const createdAt = nowIso();
  const messages: TaskMessage[] = [
    {
      id: randomUUID(),
      role: "user",
      content: input.prompt,
      createdAt,
    },
    {
      id: randomUUID(),
      role: "assistant",
      content: input.assistantText,
      createdAt: nowIso(),
      responseId: input.responseId,
    },
  ];

  task.messages.push(...messages);
  task.lastResponseId = input.responseId;
  task.lastTraceId = input.traceId ?? task.lastTraceId;
  task.status = input.status;
  task.artifacts = filterDownloadableArtifacts(input.artifacts);
  task.updatedAt = nowIso();

  const activeRun = findTaskRun(task, input.runId);
  const completedAt = nowIso();

  if (activeRun) {
    activeRun.completedAt = completedAt;
    activeRun.responseId = input.responseId ?? activeRun.responseId;
    activeRun.traceId = input.traceId ?? activeRun.traceId;
    activeRun.status = input.status === "failed" ? "failed" : "completed";
  } else if (input.status !== "idle") {
    task.runs.unshift({
      id: randomUUID(),
      startedAt: createdAt,
      completedAt,
      responseId: input.responseId,
      traceId: input.traceId,
      status: input.status === "failed" ? "failed" : "completed",
    });
  }

  await writeStore(store);

  return task;
}

export async function startTaskRun(taskId: string, options?: { traceId?: string }) {
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task) {
    throw new Error("Task not found.");
  }

  const run: TaskRun = {
    id: randomUUID(),
    startedAt: nowIso(),
    traceId: options?.traceId,
    status: "running",
  };

  task.status = "running";
  task.lastTraceId = options?.traceId ?? task.lastTraceId;
  task.runs.unshift(run);
  task.updatedAt = nowIso();

  await writeStore(store);

  return { task, run };
}

export async function setTaskStatus(taskId: string, status: TaskStatus, options?: { traceId?: string }) {
  const store = await readStore();
  const task = store.tasks.find((entry) => entry.id === taskId);

  if (!task) {
    throw new Error("Task not found.");
  }

  task.status = status;
  task.lastTraceId = options?.traceId ?? task.lastTraceId;
  if (status !== "running" && status !== "idle") {
    const activeRun = findTaskRun(task);

    if (activeRun) {
      activeRun.completedAt = activeRun.completedAt ?? nowIso();
      activeRun.traceId = options?.traceId ?? activeRun.traceId;
      activeRun.status = status === "failed" ? "failed" : "completed";
    }
  }
  task.updatedAt = nowIso();
  await writeStore(store);

  return task;
}

function findTaskRun(task: Task, runId?: string) {
  if (runId) {
    return task.runs.find((run) => run.id === runId);
  }

  return task.runs.find((run) => run.status === "running" && !run.completedAt);
}

export function buildAgentInstructions(
  task: Task,
  agent: Agent,
  contextSet: ContextSet,
  skills: SkillBundle[],
  options?: { containerWasReset?: boolean; useHostedShell?: boolean },
) {
  if (options?.useHostedShell === false) {
    return [
      "You are running in standard chat mode without a hosted shell container.",
      `The active agent is "${agent.name}".`,
      `The active context set is "${contextSet.name}".`,
      skills.length
        ? `Selected skills: ${skills.map((skill) => skill.name).join(", ")}. Skills are only attached in hosted shell mode, so explicitly say you need hosted shell access if one of them is required.`
        : null,
      "Do not claim that you edited files, ran commands, or created /mnt/data artifacts.",
      "If the user asks for file operations, code edits, execution, or data analysis over local files, clearly request escalation to hosted shell mode.",
      'During multi-step work, emit a standalone line exactly like <activity type="summary">brief progress update</activity>.',
      "Keep activity lines short and keep them out of the final answer.",
      "Provide concise, direct answers and ask clarifying questions when blocked by missing runtime access.",
      "",
      "Agent instructions:",
      agent.instructions,
      "",
      `Current task: ${task.name}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "You are operating inside an OpenAI hosted shell container.",
    `The active agent is "${agent.name}".`,
    `The active context set is "${contextSet.name}". Read the uploaded files before doing substantive work.`,
    skills.length
      ? `Attached skills: ${skills.map((skill) => skill.name).join(", ")}.`
      : null,
    options?.containerWasReset
      ? "The previous hosted container expired, so this turn is running in a freshly recreated container. Rebuild any prior generated workspace state you still need."
      : null,
    "Use the shell tool when you need to inspect or transform files.",
    'When you activate an attached skill, emit a standalone line exactly like <activity type="skill" name="skill-name">brief reason</activity> before using it.',
    'At meaningful milestones, emit a standalone line exactly like <activity type="summary">brief progress update</activity>.',
    "Keep activity lines short, use them only while working, and keep them out of the final answer.",
    "Write any user-downloadable deliverables into /mnt/data.",
    "At the end, summarize the outcome and mention the most important /mnt/data paths.",
    "",
    "Agent instructions:",
    agent.instructions,
    "",
    `Current task: ${task.name}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeShellOutput(
  output: {
    stdout: string;
    stderr: string;
    outcome: { type: string; exit_code?: number | null; exitCode?: number | null };
  }[],
) {
  return output
    .map((chunk) => {
      const parts = [];

      if (chunk.stdout.trim()) {
        parts.push(chunk.stdout.trim());
      }

      if (chunk.stderr.trim()) {
        parts.push(`stderr:\n${chunk.stderr.trim()}`);
      }

      if (chunk.outcome.type === "exit") {
        parts.push(`exit code ${chunk.outcome.exitCode ?? chunk.outcome.exit_code ?? 0}`);
      } else {
        parts.push("timed out");
      }

      return parts.join("\n");
    })
    .join("\n\n")
    .trim();
}

export function artifactFilename(pathname: string) {
  return basename(pathname) || "artifact";
}
