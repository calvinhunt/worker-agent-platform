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

export type SkillBundle = {
  id: string;
  name: string;
  filename: string;
  diskPath: string;
  openaiSkillId?: string;
  defaultVersion?: string;
  createdAt: string;
  updatedAt: string;
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

export type Task = {
  id: string;
  name: string;
  instructions: string;
  contextSetId: string;
  skillIds: string[];
  containerId?: string;
  lastResponseId?: string;
  messages: TaskMessage[];
  artifacts: TaskArtifact[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

export type AppStore = {
  contextSets: ContextSet[];
  skills: SkillBundle[];
  tasks: Task[];
};

export type ClientStatePayload = AppStore & {
  hasOpenAIKey: boolean;
  model: string;
};
