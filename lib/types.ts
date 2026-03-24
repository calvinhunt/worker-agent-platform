export type StoredFile = {
  id: string;
  name: string;
  relativePath: string;
  diskPath: string;
  size: number;
};

export type ContextSet = {
  id: string;
  name: string;
  files: StoredFile[];
  openaiFileIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SkillSource = "manual" | "curated" | "uploaded";
export type SkillFormat = "directory" | "zip";

export type SkillBundle = {
  id: string;
  name: string;
  description: string;
  slug: string;
  source: SkillSource;
  filename: string;
  diskPath: string;
  format: SkillFormat;
  files: StoredFile[];
  openaiSkillId?: string;
  defaultVersion?: string;
  originUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type CuratedSkillCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  sourceUrl: string;
};

export type TaskMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  responseId?: string;
};

export type TaskArtifact = {
  id: string;
  path: string;
  bytes: number | null;
  createdAt: number;
  source: string;
  localPath?: string;
};

export type TaskStatus = "idle" | "running" | "completed" | "failed";

export type TaskRun = {
  id: string;
  startedAt: string;
  completedAt?: string;
  responseId?: string;
  traceId?: string;
  status: "running" | "completed" | "failed";
};

export type Agent = {
  id: string;
  name: string;
  instructions: string;
  contextSetId: string;
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  agentId: string;
  name: string;
  containerId?: string;
  sessionId: string;
  lastResponseId?: string;
  lastTraceId?: string;
  messages: TaskMessage[];
  artifacts: TaskArtifact[];
  runs: TaskRun[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type AppStore = {
  agents: Agent[];
  contextSets: ContextSet[];
  skills: SkillBundle[];
  tasks: Task[];
};

export type ClientStatePayload = AppStore & {
  hasOpenAIKey: boolean;
  model: string;
};
