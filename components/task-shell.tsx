"use client";

import { FormEvent, startTransition, useEffect, useMemo, useRef, useState } from "react";

import type {
  Agent,
  ClientStatePayload,
  ContextSet,
  CuratedSkillCatalogEntry,
  SkillBundle,
  Task,
  TaskArtifact,
} from "@/lib/types";

/* ── Stream types ──────────────────────────────────────────────── */

type StreamEvent =
  | { type: "status"; status: string }
  | { type: "tool_use"; toolName: string; message: string }
  | { type: "skill_use"; skillName: string; message: string }
  | { type: "work_summary"; message: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "shell_output"; output: string }
  | { type: "done"; assistantText: string; responseId?: string; artifacts: TaskArtifact[] }
  | { type: "error"; message: string };

type ActivityEntry = {
  id: string;
  kind: "tool" | "skill" | "summary";
  label: string;
  detail: string;
};

type RunState = {
  isRunning: boolean;
  assistantDraft: string;
  shellOutput: string;
  activity: ActivityEntry[];
  error?: string;
};

type CreateAgentResponse = {
  agent: Agent;
  contextSet: ContextSet;
};

type SkillsPageResponse = {
  skills: SkillBundle[];
  curatedSkills: CuratedSkillCatalogEntry[];
  catalogError?: string;
};

/* ── Helpers ───────────────────────────────────────────────────── */

const directoryPickerProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

function emptyRunState(): RunState {
  return { isRunning: false, assistantDraft: "", shellOutput: "", activity: [] };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatSkillSource(source: SkillBundle["source"]) {
  switch (source) {
    case "manual":
      return "Manual";
    case "curated":
      return "Curated";
    default:
      return "Imported";
  }
}

function createActivityEntry(
  id: string,
  kind: ActivityEntry["kind"],
  label: string,
  detail: string,
): ActivityEntry {
  return { id, kind, label, detail };
}

async function getJson<T>(url: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Network error while loading ${url}. Check the server logs and retry.`);
    }

    throw error;
  }
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new Error(body?.error || "Request failed");
  return body as T;
}

/* ── Icons (inline SVG) ───────────────────────────────────────── */

function IconMenu({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
    </svg>
  );
}

function IconX({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function IconChevronDown({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}

function IconChevronRight({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
    </svg>
  );
}

function IconPlus({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}

function IconCog({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconDocument({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  );
}

function IconPaperAirplane({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  );
}

function IconCube({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  );
}

function IconTerminal({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );
}

function IconArrowDown({ className = "size-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

function IconBolt({ className = "size-5" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}

/* ── Status helpers ────────────────────────────────────────────── */

const statusDotColor: Record<string, string> = {
  idle: "bg-gray-300",
  running: "bg-blue-500 animate-pulse",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
};

const statusPillStyle: Record<string, string> = {
  idle: "bg-gray-100 text-gray-600",
  running: "bg-blue-50 text-blue-700",
  completed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
};

/* ── Main component ────────────────────────────────────────────── */

export function TaskShell() {
  const [state, setState] = useState<ClientStatePayload | null>(null);
  const [currentPage, setCurrentPage] = useState<"agents" | "skills">("agents");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showAgentConfig, setShowAgentConfig] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentBusy, setAgentBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [agentFormError, setAgentFormError] = useState<string | null>(null);
  const [taskFormError, setTaskFormError] = useState<string | null>(null);
  const [skillsPageError, setSkillsPageError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [contextSetName, setContextSetName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [contextFiles, setContextFiles] = useState<File[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillBusy, setSkillBusy] = useState(false);
  const [installingSkillSlug, setInstallingSkillSlug] = useState<string | null>(null);
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [curatedSkills, setCuratedSkills] = useState<CuratedSkillCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogInitialized, setCatalogInitialized] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runState, setRunState] = useState<RunState>(emptyRunState);
  const [stateRefreshError, setStateRefreshError] = useState<string | null>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const activityEntryIdRef = useRef(0);

  const tasksByAgent = useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of state?.tasks ?? []) {
      grouped.set(task.agentId, [...(grouped.get(task.agentId) ?? []), task]);
    }
    return grouped;
  }, [state]);

  const selectedTask = useMemo(
    () => state?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, state],
  );

  const selectedAgent = useMemo(() => {
    if (!state) return null;
    if (selectedTask) return state.agents.find((agent) => agent.id === selectedTask.agentId) ?? null;
    return state.agents.find((agent) => agent.id === selectedAgentId) ?? null;
  }, [selectedAgentId, selectedTask, state]);

  const selectedContextSet = useMemo(
    () =>
      selectedAgent
        ? state?.contextSets.find((cs) => cs.id === selectedAgent.contextSetId) ?? null
        : null,
    [selectedAgent, state],
  );

  const selectedSkills = useMemo(
    () =>
      selectedAgent
        ? state?.skills.filter((s) => selectedAgent.skillIds.includes(s.id)) ?? []
        : [],
    [selectedAgent, state],
  );

  const selectedAgentTasks = useMemo(
    () => (selectedAgent ? tasksByAgent.get(selectedAgent.id) ?? [] : []),
    [selectedAgent, tasksByAgent],
  );

  const skillUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const agent of state?.agents ?? []) {
      for (const skillId of agent.skillIds) {
        counts.set(skillId, (counts.get(skillId) ?? 0) + 1);
      }
    }

    return counts;
  }, [state]);

  const installedCuratedSkillSlugs = useMemo(
    () =>
      new Set(
        (state?.skills ?? [])
          .filter((skill) => skill.source === "curated")
          .map((skill) => skill.slug),
      ),
    [state],
  );

  async function refreshState(preferred?: { agentId?: string | null; taskId?: string | null }) {
    try {
      const nextState = await getJson<ClientStatePayload>("/api/state");
      setState(nextState);
      setSelectedSkillIds((current) =>
        current.filter((skillId) => nextState.skills.some((skill) => skill.id === skillId)),
      );
      setStateRefreshError(null);

      const preferredTask =
        preferred?.taskId && nextState.tasks.some((t) => t.id === preferred.taskId)
          ? nextState.tasks.find((t) => t.id === preferred.taskId) ?? null
          : null;
      const currentTask =
        !preferredTask && selectedTaskId && nextState.tasks.some((t) => t.id === selectedTaskId)
          ? nextState.tasks.find((t) => t.id === selectedTaskId) ?? null
          : null;
      const nextTask = preferredTask ?? currentTask;

      const preferredAgentId = preferred?.agentId || nextTask?.agentId || null;
      const nextAgentId =
        (preferredAgentId && nextState.agents.some((a) => a.id === preferredAgentId)
          ? preferredAgentId
          : null) ||
        (selectedAgentId && nextState.agents.some((a) => a.id === selectedAgentId)
          ? selectedAgentId
          : null) ||
        nextState.agents[0]?.id ||
        null;

      setSelectedTaskId(nextTask?.id ?? null);
      setSelectedAgentId(nextAgentId);
      setExpandedAgents((cur) => {
        const next = { ...cur };
        if (nextAgentId) next[nextAgentId] = true;
        return next;
      });
    } catch (error) {
      setStateRefreshError(error instanceof Error ? error.message : "Failed to refresh state.");
    }
  }

  async function refreshSkillsCatalog() {
    setCatalogLoading(true);

    try {
      const payload = await getJson<SkillsPageResponse>("/api/skills");
      setCuratedSkills(payload.curatedSkills);
      setSkillsPageError(payload.catalogError || null);
    } catch (error) {
      setSkillsPageError(
        error instanceof Error ? error.message : "Failed to load curated skills.",
      );
    } finally {
      setCatalogInitialized(true);
      setCatalogLoading(false);
    }
  }

  function appendActivityEntry(
    kind: ActivityEntry["kind"],
    label: string,
    detail: string,
  ) {
    const id = `activity-${activityEntryIdRef.current++}`;

    setRunState((current) => ({
      ...current,
      activity: [...current.activity, createActivityEntry(id, kind, label, detail)],
    }));
  }

  useEffect(() => {
    void (async () => {
      try {
        await refreshState();
      } catch {
        // Error surfaced through stateRefreshError.
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setRunState(emptyRunState());
  }, [selectedTaskId]);

  useEffect(() => {
    if (currentPage !== "skills" || catalogInitialized || catalogLoading) {
      return;
    }

    void refreshSkillsCatalog();
  }, [catalogInitialized, catalogLoading, currentPage]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selectedTask?.messages.length, runState.assistantDraft]);

  /* ── Handlers ─────────────────────────────────────────────── */

  async function handleCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAgentBusy(true);
    setAgentFormError(null);

    try {
      if (!contextSetName.trim()) throw new Error("Context set name is required.");
      if (!instructions.trim()) throw new Error("Agent instructions are required.");
      if (!contextFiles.length) throw new Error("Upload at least one context file or folder.");

      const form = new FormData();
      form.set("name", agentName.trim());
      form.set("instructions", instructions.trim());
      form.set("contextSetName", contextSetName.trim());
      form.set("selectedSkillIds", JSON.stringify(selectedSkillIds));

      for (const file of contextFiles) {
        form.append("files", file, file.webkitRelativePath || file.name);
      }

      const result = await getJson<CreateAgentResponse>("/api/agents", {
        method: "POST",
        body: form,
      });

      setAgentName("");
      setContextSetName("");
      setInstructions("");
      setContextFiles([]);
      setSelectedSkillIds([]);
      setSelectedTaskId(null);
      setExpandedAgents((cur) => ({ ...cur, [result.agent.id]: true }));

      startTransition(() => {
        void refreshState({ agentId: result.agent.id, taskId: null });
      });
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : "Failed to create agent.");
    } finally {
      setAgentBusy(false);
    }
  }

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTaskBusy(true);
    setTaskFormError(null);

    try {
      if (!selectedAgent) throw new Error("Select an agent first.");

      const task = await getJson<Task>("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgent.id, name: newTaskName.trim() }),
      });

      setNewTaskName("");
      setSelectedTaskId(task.id);
      setExpandedAgents((cur) => ({ ...cur, [selectedAgent.id]: true }));

      startTransition(() => {
        void refreshState({ agentId: selectedAgent.id, taskId: task.id });
      });
    } catch (error) {
      setTaskFormError(error instanceof Error ? error.message : "Failed to create task.");
    } finally {
      setTaskBusy(false);
    }
  }

  async function handleCreateSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSkillBusy(true);
    setSkillsPageError(null);

    try {
      const skill = await getJson<SkillBundle>("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skillName.trim(),
          description: skillDescription.trim(),
          instructions: skillInstructions.trim(),
        }),
      });

      setSkillName("");
      setSkillDescription("");
      setSkillInstructions("");
      setSelectedSkillIds((current) => [...current, skill.id]);

      await Promise.all([refreshState(), refreshSkillsCatalog()]);
    } catch (error) {
      setSkillsPageError(error instanceof Error ? error.message : "Failed to create skill.");
    } finally {
      setSkillBusy(false);
    }
  }

  async function handleInstallCuratedSkill(slug: string) {
    setInstallingSkillSlug(slug);
    setSkillsPageError(null);

    try {
      const skill = await getJson<SkillBundle>("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });

      setSelectedSkillIds((current) =>
        current.includes(skill.id) ? current : [...current, skill.id],
      );

      await Promise.all([refreshState(), refreshSkillsCatalog()]);
    } catch (error) {
      setSkillsPageError(error instanceof Error ? error.message : "Failed to install skill.");
    } finally {
      setInstallingSkillSlug(null);
    }
  }

  async function handleRemoveSkill(skillId: string) {
    const skill = state?.skills.find((entry) => entry.id === skillId);

    if (!skill) {
      return;
    }

    const confirmed = window.confirm(
      `Remove "${skill.name}" from installed skills? Any agents using it will be detached automatically.`,
    );

    if (!confirmed) {
      return;
    }

    setRemovingSkillId(skillId);
    setSkillsPageError(null);

    try {
      await getJson<{ deleted: boolean }>(`/api/skills/${skillId}`, {
        method: "DELETE",
      });

      setSelectedSkillIds((current) => current.filter((entry) => entry !== skillId));
      await Promise.all([refreshState(), refreshSkillsCatalog()]);
    } catch (error) {
      setSkillsPageError(error instanceof Error ? error.message : "Failed to remove skill.");
    } finally {
      setRemovingSkillId(null);
    }
  }

  async function handleRunPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask || !prompt.trim()) return;

    setRunState({
      isRunning: true,
      assistantDraft: "",
      shellOutput: "",
      activity: [
        createActivityEntry(
          `activity-${activityEntryIdRef.current++}`,
          "summary",
          "Summary",
          "Reviewing the task, context files, and available skills.",
        ),
      ],
    });

    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        let errorMessage = "Streaming response failed.";
        if (text) {
          try {
            errorMessage = (JSON.parse(text) as { error?: string }).error || errorMessage;
          } catch {
            errorMessage = text;
          }
        }
        throw new Error(errorMessage);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            setRunState((s) => ({
              ...s,
              error: "Received a malformed stream response from the server.",
            }));
            continue;
          }

          if (event.type === "assistant_delta") {
            setRunState((s) => ({ ...s, assistantDraft: s.assistantDraft + event.delta }));
          }
          if (event.type === "tool_use") {
            appendActivityEntry("tool", "Tool", event.message);
          }
          if (event.type === "skill_use") {
            appendActivityEntry("skill", event.skillName, event.message);
          }
          if (event.type === "work_summary") {
            appendActivityEntry("summary", "Summary", event.message);
          }
          if (event.type === "shell_output") {
            setRunState((s) => ({
              ...s,
              shellOutput: [s.shellOutput, event.output].filter(Boolean).join("\n\n"),
            }));
          }
          if (event.type === "error") {
            setRunState((s) => ({ ...s, error: event.message }));
          }
          if (event.type === "done") {
            setRunState((s) => ({
              ...s,
              isRunning: false,
              assistantDraft: event.assistantText,
            }));
            startTransition(() => {
              void refreshState({ agentId: selectedTask.agentId, taskId: selectedTask.id }).finally(
                () => setRunState(emptyRunState()),
              );
            });
          }
        }
      }

      setPrompt("");
      setRunState((s) => ({ ...s, isRunning: false }));
    } catch (error) {
      setRunState((s) => ({
        ...s,
        isRunning: false,
        error: error instanceof Error ? error.message : "Run failed.",
      }));
    }
  }

  function openNewAgent() {
    setCurrentPage("agents");
    setSelectedAgentId(null);
    setSelectedTaskId(null);
    setShowAgentConfig(false);
  }

  function openSkillsPage() {
    setCurrentPage("skills");
    setShowAgentConfig(false);
  }

  function selectAgent(agentId: string) {
    setCurrentPage("agents");
    setSelectedAgentId(agentId);
    setSelectedTaskId(null);
    setExpandedAgents((cur) => ({ ...cur, [agentId]: true }));
  }

  function selectTask(task: Task) {
    setCurrentPage("agents");
    setSelectedAgentId(task.agentId);
    setSelectedTaskId(task.id);
    setExpandedAgents((cur) => ({ ...cur, [task.agentId]: true }));
  }

  function startTaskCreation(agentId: string) {
    setCurrentPage("agents");
    setSelectedAgentId(agentId);
    setSelectedTaskId(null);
    setExpandedAgents((cur) => ({ ...cur, [agentId]: true }));
  }

  /* ── Loading ──────────────────────────────────────────────── */

  if (loading || !state) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="size-8 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
          <p className="text-sm text-gray-500">Loading workspace...</p>
        </div>
      </div>
    );
  }

  /* ── Render ───────────────────────────────────────────────── */

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-gray-900/60 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────── */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-gray-900
          transition-transform duration-200 ease-in-out
          lg:static lg:translate-x-0
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-white/10 px-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500">
            <IconCube className="size-4.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-white">Agent Containers</span>
          <button
            className="ml-auto rounded-md p-1 text-gray-400 hover:text-white lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <IconX className="size-5" />
          </button>
        </div>

        <div className="px-4 pt-4">
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-800/70 p-1">
            <button
              onClick={() => setCurrentPage("agents")}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                currentPage === "agents"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-300 hover:text-white"
              }`}
            >
              Agents
            </button>
            <button
              onClick={openSkillsPage}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                currentPage === "skills"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-300 hover:text-white"
              }`}
            >
              Skills
            </button>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2">
          {currentPage === "agents" ? (
            <>
              <div className="px-1 pt-3 pb-2">
                <button
                  onClick={openNewAgent}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
                >
                  <IconPlus className="size-4" />
                  New Agent
                </button>
              </div>

              <p className="mb-2 px-2 text-xs font-medium tracking-wide text-gray-400 uppercase">
                Agents
              </p>

              {state.agents.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-gray-500">
                  Create your first agent to begin.
                </p>
              )}

              <ul className="space-y-1">
                {state.agents.map((agent) => {
                  const tasks = tasksByAgent.get(agent.id) ?? [];
                  const isExpanded =
                    expandedAgents[agent.id] ??
                    (selectedAgentId === agent.id || tasks.some((t) => t.id === selectedTaskId));
                  const isSelected = selectedAgentId === agent.id && !selectedTaskId;

                  return (
                    <li key={agent.id}>
                      <div className="flex min-w-0 items-center">
                        <button
                          onClick={() => selectAgent(agent.id)}
                          className={`
                            group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors
                            ${isSelected
                              ? "bg-gray-800 text-white"
                              : "text-gray-300 hover:bg-gray-800 hover:text-white"
                            }
                          `}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-gray-800 text-xs font-bold text-indigo-400 ring-1 ring-white/10 group-hover:ring-white/20">
                            {agent.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="truncate">{agent.name}</span>
                        </button>
                        <button
                          onClick={() =>
                            setExpandedAgents((cur) => ({ ...cur, [agent.id]: !isExpanded }))
                          }
                          className="shrink-0 rounded-md p-1.5 text-gray-500 transition-colors hover:text-gray-300"
                        >
                          {isExpanded ? (
                            <IconChevronDown className="size-3.5" />
                          ) : (
                            <IconChevronRight className="size-3.5" />
                          )}
                        </button>
                      </div>

                      {isExpanded && (
                        <ul className="mt-1 ml-4 space-y-0.5 border-l border-gray-700 pl-3">
                          <li>
                            <button
                              onClick={() => startTaskCreation(agent.id)}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gray-500 transition-colors hover:text-gray-300"
                            >
                              <IconPlus className="size-3.5" />
                              New Task
                            </button>
                          </li>
                          {tasks.map((task) => {
                            const isActive = selectedTaskId === task.id;
                            return (
                              <li key={task.id}>
                                <button
                                  onClick={() => selectTask(task)}
                                  className={`
                                    flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors
                                    ${isActive
                                      ? "bg-gray-800 text-white"
                                      : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-200"
                                    }
                                  `}
                                >
                                  <span className={`size-1.5 shrink-0 rounded-full ${statusDotColor[task.status] || "bg-gray-400"}`} />
                                  <span className="truncate">{task.name}</span>
                                </button>
                              </li>
                            );
                          })}
                          {tasks.length === 0 && (
                            <li className="px-2 py-1.5 text-xs text-gray-600">No tasks yet</li>
                          )}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <div className="space-y-4 px-1 pt-3">
              <div className="rounded-xl border border-white/10 bg-gray-800/70 px-4 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Installed Skills
                </p>
                <p className="mt-2 text-2xl font-semibold text-white">{state.skills.length}</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                  Create skills with a `SKILL.md` file or install them from the curated OpenAI repository, then attach only the ones each agent should use.
                </p>
              </div>

              <div>
                <p className="mb-2 px-2 text-xs font-medium tracking-wide text-gray-400 uppercase">
                  Installed
                </p>
                <div className="space-y-1">
                  {state.skills.length > 0 ? (
                    state.skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="rounded-lg border border-white/10 bg-gray-800/60 px-3 py-2"
                      >
                        <p className="truncate text-sm font-medium text-white">{skill.name}</p>
                        <p className="mt-1 text-xs text-gray-400">
                          {formatSkillSource(skill.source)}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-xs text-gray-500">
                      No installed skills yet.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <IconTerminal className="size-4" />
            <span>Model: {state.model}</span>
          </div>
        </div>
      </aside>

      {/* ── Main area ────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-4 sm:px-6">
          <button
            onClick={() => setSidebarOpen((c) => !c)}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 lg:hidden"
          >
            <IconMenu className="size-5" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-3">
            {currentPage === "skills" ? (
              <div>
                <h1 className="text-sm font-semibold text-gray-900">Skills</h1>
                <p className="text-xs text-gray-500">
                  Manage installed skills and choose which agents use them.
                </p>
              </div>
            ) : selectedAgent ? (
              <nav className="flex items-center gap-1.5 text-sm text-gray-500">
                <button
                  onClick={() => selectAgent(selectedAgent.id)}
                  className="truncate hover:text-gray-900 transition-colors max-w-[200px]"
                >
                  {selectedAgent.name}
                </button>
                {selectedTask && (
                  <>
                    <span className="text-gray-300">/</span>
                    <span className="truncate font-medium text-gray-900 max-w-[240px]">
                      {selectedTask.name}
                    </span>
                  </>
                )}
              </nav>
            ) : (
              <h1 className="text-sm font-semibold text-gray-900">Create a new agent</h1>
            )}
          </div>

          <div className="flex items-center gap-2">
            {currentPage === "agents" && selectedAgent && (
              <>
                <button
                  onClick={() => setShowAgentConfig(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors"
                >
                  <IconCog className="size-4 text-gray-400" />
                  Config
                </button>
                <button
                  onClick={() => startTaskCreation(selectedAgent.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 transition-colors"
                >
                  <IconPlus className="size-4" />
                  New Task
                </button>
              </>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            {stateRefreshError && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {stateRefreshError}
              </div>
            )}

            {currentPage === "skills" && (
              <div className="space-y-6">
                <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                      <h2 className="text-base font-semibold text-gray-900">Create Skill</h2>
                      <p className="mt-1 text-sm text-gray-500">
                        Skills are folders with a <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">SKILL.md</code>. The description should say exactly when the skill should and should not trigger.
                      </p>
                    </div>

                    <form className="space-y-5 px-6 py-5" onSubmit={handleCreateSkill}>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Skill name
                        </label>
                        <input
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setSkillName(e.target.value)}
                          placeholder="e.g. release-notes"
                          value={skillName}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Trigger description
                        </label>
                        <textarea
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setSkillDescription(e.target.value)}
                          placeholder="Explain when the skill should trigger and when it should not."
                          rows={3}
                          value={skillDescription}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Instructions
                        </label>
                        <textarea
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setSkillInstructions(e.target.value)}
                          placeholder="Write the steps, inputs, outputs, and guardrails the skill should follow."
                          rows={10}
                          value={skillInstructions}
                        />
                      </div>

                      <div className="flex items-center justify-end border-t border-gray-100 pt-4">
                        <button
                          type="submit"
                          disabled={skillBusy}
                          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 disabled:opacity-50"
                        >
                          {skillBusy ? (
                            <>
                              <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              Saving...
                            </>
                          ) : (
                            "Create Skill"
                          )}
                        </button>
                      </div>
                    </form>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h2 className="text-base font-semibold text-gray-900">
                            Install Curated Skills
                          </h2>
                          <p className="mt-1 text-sm text-gray-500">
                            Install from the OpenAI curated skills repository and make them available to agents during creation.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void refreshSkillsCatalog()}
                          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                        >
                          Refresh
                        </button>
                      </div>
                    </div>

                    <div className="px-6 py-5">
                      {catalogLoading ? (
                        <div className="flex items-center gap-3 py-10 text-sm text-gray-500">
                          <div className="size-5 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" />
                          Loading curated skills...
                        </div>
                      ) : curatedSkills.length > 0 ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          {curatedSkills.map((skill) => {
                            const isInstalled = installedCuratedSkillSlugs.has(skill.slug);
                            const isInstalling = installingSkillSlug === skill.slug;

                            return (
                              <div
                                key={skill.slug}
                                className="flex h-full flex-col justify-between rounded-xl border border-gray-200 bg-gray-50/60 p-4"
                              >
                                <div>
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <h3 className="text-sm font-semibold text-gray-900">
                                        {skill.name}
                                      </h3>
                                      <p className="mt-1 text-xs font-medium uppercase tracking-wide text-gray-400">
                                        {skill.slug}
                                      </p>
                                    </div>
                                    <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-gray-500 ring-1 ring-gray-200">
                                      Curated
                                    </span>
                                  </div>
                                  <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                    {skill.description || "Install this curated skill to inspect its full instructions and attach it to agents."}
                                  </p>
                                </div>

                                <div className="mt-4 flex items-center justify-between gap-3">
                                  <a
                                    className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
                                    href={skill.sourceUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    View source
                                  </a>
                                  <button
                                    type="button"
                                    disabled={isInstalled || isInstalling}
                                    onClick={() => handleInstallCuratedSkill(skill.slug)}
                                    className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                                      isInstalled
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-gray-900 text-white hover:bg-gray-800"
                                    } disabled:cursor-not-allowed disabled:opacity-70`}
                                  >
                                    {isInstalling ? (
                                      <>
                                        <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                        Installing...
                                      </>
                                    ) : isInstalled ? (
                                      "Installed"
                                    ) : (
                                      "Install"
                                    )}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="py-6 text-sm text-gray-500">
                          Curated skills are unavailable right now.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {(skillsPageError || state.skills.length > 0 || currentPage === "skills") && (
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h2 className="text-base font-semibold text-gray-900">
                            Installed Skills
                          </h2>
                          <p className="mt-1 text-sm text-gray-500">
                            Agents can attach any subset of these installed skills.
                          </p>
                        </div>
                        <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                          {state.skills.length} installed
                        </span>
                      </div>
                    </div>

                    <div className="px-6 py-5">
                      {skillsPageError && (
                        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">
                          {skillsPageError}
                        </div>
                      )}

                      {state.skills.length > 0 ? (
                        <div className="grid gap-4 lg:grid-cols-2">
                          {state.skills.map((skill) => {
                            const attachedAgents = skillUsageCounts.get(skill.id) ?? 0;

                            return (
                              <div
                                key={skill.id}
                                className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm"
                              >
                                <div className="flex items-start justify-between gap-4">
                                  <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <h3 className="text-base font-semibold text-gray-900">
                                        {skill.name}
                                      </h3>
                                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                                        {formatSkillSource(skill.source)}
                                      </span>
                                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                                        {skill.format}
                                      </span>
                                    </div>
                                    <p className="mt-2 text-sm leading-relaxed text-gray-600">
                                      {skill.description || "No description provided."}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={removingSkillId === skill.id}
                                    onClick={() => handleRemoveSkill(skill.id)}
                                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
                                  >
                                    {removingSkillId === skill.id ? "Removing..." : "Remove"}
                                  </button>
                                </div>

                                <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-500">
                                  <span className="rounded-full bg-gray-50 px-3 py-1 ring-1 ring-gray-200">
                                    {attachedAgents} agent{attachedAgents === 1 ? "" : "s"}
                                  </span>
                                  <span className="rounded-full bg-gray-50 px-3 py-1 ring-1 ring-gray-200">
                                    {skill.files.length || 1} file{skill.files.length === 1 ? "" : "s"}
                                  </span>
                                  <span className="rounded-full bg-gray-50 px-3 py-1 ring-1 ring-gray-200">
                                    Added {formatDate(skill.createdAt)}
                                  </span>
                                </div>

                                {(skill.originUrl || skill.files.length > 0) && (
                                  <div className="mt-4 space-y-2">
                                    {skill.originUrl && (
                                      <a
                                        className="inline-flex text-sm font-medium text-indigo-600 hover:text-indigo-500"
                                        href={skill.originUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        View source repository
                                      </a>
                                    )}
                                    {skill.files.length > 0 && (
                                      <div className="flex flex-wrap gap-2">
                                        {skill.files.slice(0, 4).map((file) => (
                                          <span
                                            key={file.id}
                                            className="rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-500 ring-1 ring-gray-200"
                                          >
                                            {file.relativePath}
                                          </span>
                                        ))}
                                        {skill.files.length > 4 && (
                                          <span className="rounded-full bg-gray-50 px-3 py-1 text-xs text-gray-500 ring-1 ring-gray-200">
                                            +{skill.files.length - 4} more
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-6 py-10 text-center">
                          <IconBolt className="mx-auto size-7 text-gray-300" />
                          <p className="mt-3 text-sm font-medium text-gray-600">
                            No installed skills yet
                          </p>
                          <p className="mt-1 text-sm text-gray-500">
                            Create a new skill or install one from the curated repository above.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── New Agent form ──────────────────────────────── */}
            {currentPage === "agents" && !selectedAgent && (
              <div className="mx-auto max-w-2xl">
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                    <h2 className="text-base font-semibold text-gray-900">New Agent</h2>
                    <p className="mt-1 text-sm text-gray-500">
                      Define context, instructions, and choose which installed skills this agent should use.
                    </p>
                  </div>

                  <form className="divide-y divide-gray-100" onSubmit={handleCreateAgent}>
                    <div className="space-y-5 px-6 py-5">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Agent name
                        </label>
                        <input
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setAgentName(e.target.value)}
                          placeholder="Leave blank to auto-name"
                          value={agentName}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Instructions
                        </label>
                        <textarea
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setInstructions(e.target.value)}
                          placeholder="Describe how this agent should approach tasks."
                          rows={4}
                          value={instructions}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Context set name
                        </label>
                        <input
                          className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                          onChange={(e) => setContextSetName(e.target.value)}
                          placeholder="e.g. client-documents"
                          value={contextSetName}
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Context files
                        </label>
                        <div className="mt-1.5 flex items-center gap-3">
                          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors">
                            <IconDocument className="size-4 text-gray-400" />
                            Choose files
                            <input
                              className="sr-only"
                              multiple
                              onChange={(e) => setContextFiles(Array.from(e.target.files || []))}
                              type="file"
                              {...directoryPickerProps}
                            />
                          </label>
                          <span className="text-sm text-gray-500">
                            {contextFiles.length
                              ? `${contextFiles.length} file${contextFiles.length > 1 ? "s" : ""} selected`
                              : "No files selected"}
                          </span>
                        </div>
                      </div>

                      {state.skills.length > 0 ? (
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Installed skills
                          </label>
                          <p className="mt-1 text-sm text-gray-500">
                            Select only the installed skills this agent should have available.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {state.skills.map((skill) => {
                              const checked = selectedSkillIds.includes(skill.id);
                              return (
                                <label
                                  key={skill.id}
                                  className={`
                                    inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors
                                    ${checked
                                      ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                                    }
                                  `}
                                >
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={checked}
                                    onChange={(e) =>
                                      setSelectedSkillIds((cur) =>
                                        e.target.checked
                                          ? [...cur, skill.id]
                                          : cur.filter((id) => id !== skill.id),
                                      )
                                    }
                                  />
                                  <IconBolt className="size-3.5" />
                                  {skill.name}
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-4 py-4">
                          <p className="text-sm font-medium text-gray-700">No installed skills yet</p>
                          <p className="mt-1 text-sm text-gray-500">
                            Create or install skills first, then come back to attach them to this agent.
                          </p>
                          <button
                            type="button"
                            onClick={openSkillsPage}
                            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                          >
                            <IconBolt className="size-4 text-gray-400" />
                            Open Skills
                          </button>
                        </div>
                      )}
                    </div>

                    {agentFormError && (
                      <div className="bg-red-50 px-6 py-3">
                        <p className="text-sm text-red-600">{agentFormError}</p>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-3 px-6 py-4 bg-gray-50/50">
                      <button
                        type="submit"
                        disabled={agentBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                      >
                        {agentBusy ? (
                          <>
                            <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            Creating...
                          </>
                        ) : (
                          "Create Agent"
                        )}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* ── Task view ───────────────────────────────────── */}
            {currentPage === "agents" && selectedAgent && selectedTask && (
              <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
                {/* Left column: conversation */}
                <div className="min-w-0 space-y-5">
                  {/* Prompt composer */}
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <form onSubmit={handleRunPrompt}>
                      <div className="px-5 pt-4 pb-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <h2 className="text-sm font-semibold text-gray-900">Prompt</h2>
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusPillStyle[selectedTask.status] || "bg-gray-100 text-gray-600"}`}>
                              {selectedTask.status}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span>{selectedTask.messages.length} messages</span>
                            <span className="text-gray-200">|</span>
                            <span>{selectedTask.artifacts.length} outputs</span>
                          </div>
                        </div>
                      </div>
                      <div className="px-5 pb-4">
                        <textarea
                          className="block w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm placeholder:text-gray-400 focus:border-indigo-500 focus:bg-white focus:ring-1 focus:ring-indigo-500 focus:outline-none transition-colors"
                          onChange={(e) => setPrompt(e.target.value)}
                          placeholder="Ask the agent to work on something..."
                          rows={3}
                          value={prompt}
                        />
                      </div>
                      <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/50 px-5 py-3">
                        <span className="text-xs text-gray-400">
                          Created {formatDate(selectedTask.createdAt)}
                        </span>
                        <button
                          type="submit"
                          disabled={runState.isRunning || !prompt.trim()}
                          className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                        >
                          {runState.isRunning ? (
                            <>
                              <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                              Running...
                            </>
                          ) : (
                            <>
                              <IconPaperAirplane className="size-4" />
                              Send
                            </>
                          )}
                        </button>
                      </div>
                    </form>
                  </div>

                  {/* Conversation */}
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-5 py-3">
                      <h3 className="text-sm font-semibold text-gray-900">Conversation</h3>
                    </div>
                    <div className="divide-y divide-gray-100">
                      {selectedTask.messages.length === 0 && !runState.assistantDraft && (
                        <div className="px-5 py-10 text-center">
                          <IconTerminal className="mx-auto size-8 text-gray-300" />
                          <p className="mt-2 text-sm text-gray-400">
                            No messages yet. Send a prompt above.
                          </p>
                        </div>
                      )}

                      {selectedTask.messages.map((message) => (
                        <div key={message.id} className="px-5 py-4">
                          <div className="flex items-start gap-3">
                            <div
                              className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                message.role === "user"
                                  ? "bg-gray-100 text-gray-600"
                                  : "bg-indigo-100 text-indigo-600"
                              }`}
                            >
                              {message.role === "user" ? "U" : "A"}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                                {message.role}
                              </p>
                              <div className="mt-1 text-sm leading-relaxed text-gray-700 whitespace-pre-wrap">
                                {message.content}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}

                      {runState.assistantDraft && (
                        <div className="bg-indigo-50/30 px-5 py-4">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-600">
                              A
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-indigo-600 uppercase tracking-wide flex items-center gap-1.5">
                                assistant
                                {runState.isRunning && (
                                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-indigo-500" />
                                )}
                              </p>
                              <div className="mt-1 text-sm leading-relaxed text-gray-700 whitespace-pre-wrap">
                                {runState.assistantDraft}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      <div ref={conversationEndRef} />
                    </div>
                  </div>
                </div>

                {/* Right rail */}
                <div className="space-y-5">
                  {/* Outputs */}
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-4 py-3">
                      <h3 className="text-sm font-semibold text-gray-900">Outputs</h3>
                      <p className="mt-0.5 text-xs text-gray-400">
                        Files from <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">/mnt/data</code>
                      </p>
                    </div>
                    {selectedTask.artifacts.length > 0 ? (
                      <ul className="divide-y divide-gray-100">
                        {selectedTask.artifacts.map((artifact) => (
                          <li key={artifact.id}>
                            <a
                              href={`/api/tasks/${selectedTask.id}/artifacts/${artifact.id}`}
                              className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-gray-50 transition-colors"
                            >
                              <IconArrowDown className="size-4 shrink-0 text-gray-400" />
                              <span className="min-w-0 flex-1 truncate text-gray-700">
                                {artifact.path}
                              </span>
                              <span className="shrink-0 text-xs text-gray-400">
                                {formatBytes(artifact.bytes)}
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="px-4 py-6 text-center">
                        <IconDocument className="mx-auto size-6 text-gray-300" />
                        <p className="mt-1.5 text-xs text-gray-400">No outputs yet</p>
                      </div>
                    )}
                  </div>

                  {/* Activity */}
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-4 py-3">
                      <h3 className="text-sm font-semibold text-gray-900">Activity</h3>
                    </div>
                    <div className="px-4 py-3">
                      {runState.activity.length > 0 ? (
                        <ul className="space-y-2">
                          {runState.activity.map((entry) => (
                            <li
                              key={entry.id}
                              className="rounded-lg border border-gray-100 bg-gray-50/70 px-3 py-2"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                                    entry.kind === "tool"
                                      ? "bg-blue-50 text-blue-700"
                                      : entry.kind === "skill"
                                        ? "bg-amber-50 text-amber-700"
                                        : "bg-gray-100 text-gray-600"
                                  }`}
                                >
                                  {entry.label}
                                </span>
                              </div>
                              <p className="mt-1 text-xs leading-relaxed text-gray-600">
                                {entry.detail}
                              </p>
                            </li>
                          ))}
                        </ul>
                      ) : selectedTask.runs.length > 0 ? (
                        <ul className="space-y-1.5">
                          {selectedTask.runs
                            .slice()
                            .reverse()
                            .map((run) => (
                              <li key={run.id} className="flex items-start gap-2 text-xs text-gray-500">
                                <span
                                  className={`mt-1.5 block size-1 shrink-0 rounded-full ${
                                    run.status === "failed"
                                      ? "bg-red-400"
                                      : run.status === "running"
                                        ? "bg-blue-400"
                                        : "bg-emerald-400"
                                  }`}
                                />
                                <span>
                                  Run {run.status} at {formatDateTime(run.startedAt)}
                                  {run.completedAt
                                    ? ` · finished ${formatDateTime(run.completedAt)}`
                                    : ""}
                                </span>
                              </li>
                            ))}
                        </ul>
                      ) : (
                        <p className="py-3 text-center text-xs text-gray-400">No activity yet</p>
                      )}
                      {runState.error && (
                        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                          {runState.error}
                        </p>
                      )}
                    </div>

                    {/* Shell output */}
                    <details className="border-t border-gray-100">
                      <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors">
                        Shell output
                      </summary>
                      <pre className="max-h-56 overflow-auto border-t border-gray-100 bg-gray-900 px-4 py-3 font-mono text-xs text-gray-300 leading-relaxed">
                        {runState.shellOutput || "No shell output captured."}
                      </pre>
                    </details>
                  </div>
                </div>
              </div>
            )}

            {/* ── New Task + task list (agent selected, no task) ── */}
            {currentPage === "agents" && selectedAgent && !selectedTask && (
              <div className="mx-auto max-w-2xl space-y-6">
                {/* New task form */}
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                  <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-4">
                    <h2 className="text-base font-semibold text-gray-900">New Task</h2>
                    <p className="mt-1 text-sm text-gray-500">
                      Create a task under <span className="font-medium text-gray-700">{selectedAgent.name}</span>. It inherits the agent&apos;s context and skills.
                    </p>
                  </div>

                  <form onSubmit={handleCreateTask}>
                    <div className="px-6 py-5">
                      <label className="block text-sm font-medium text-gray-700">Task name</label>
                      <input
                        className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        onChange={(e) => setNewTaskName(e.target.value)}
                        placeholder="Leave blank to auto-name"
                        value={newTaskName}
                      />
                    </div>

                    {taskFormError && (
                      <div className="bg-red-50 px-6 py-3">
                        <p className="text-sm text-red-600">{taskFormError}</p>
                      </div>
                    )}

                    <div className="flex items-center justify-between border-t border-gray-100 bg-gray-50/50 px-6 py-4">
                      <span className="text-xs text-gray-400">
                        {selectedAgentTasks.length} existing task{selectedAgentTasks.length !== 1 ? "s" : ""}
                      </span>
                      <button
                        type="submit"
                        disabled={taskBusy}
                        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                      >
                        {taskBusy ? (
                          <>
                            <div className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                            Creating...
                          </>
                        ) : (
                          "Create Task"
                        )}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Existing tasks */}
                {selectedAgentTasks.length > 0 && (
                  <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
                    <div className="border-b border-gray-100 bg-gray-50/50 px-6 py-3">
                      <h3 className="text-sm font-semibold text-gray-900">Tasks</h3>
                    </div>
                    <ul className="divide-y divide-gray-100">
                      {selectedAgentTasks.map((task) => (
                        <li key={task.id}>
                          <button
                            onClick={() => selectTask(task)}
                            className="flex w-full items-center gap-3 px-6 py-3.5 text-left text-sm hover:bg-gray-50 transition-colors"
                          >
                            <span className={`size-2 shrink-0 rounded-full ${statusDotColor[task.status] || "bg-gray-300"}`} />
                            <span className="min-w-0 flex-1 truncate font-medium text-gray-700">
                              {task.name}
                            </span>
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusPillStyle[task.status] || "bg-gray-100 text-gray-600"}`}>
                              {task.status}
                            </span>
                            <IconChevronRight className="size-4 text-gray-300" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ── Agent config modal ──────────────────────────────── */}
      {showAgentConfig && selectedAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm"
            onClick={() => setShowAgentConfig(false)}
          />
          <div className="relative z-10 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-auto rounded-2xl border border-gray-200 bg-white shadow-xl">
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4">
              <div>
                <p className="text-xs font-medium tracking-wide text-gray-400 uppercase">
                  Agent Configuration
                </p>
                <h3 className="mt-1 text-lg font-semibold text-gray-900">{selectedAgent.name}</h3>
              </div>
              <button
                onClick={() => setShowAgentConfig(false)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              >
                <IconX className="size-5" />
              </button>
            </div>

            <div className="divide-y divide-gray-100">
              {/* Instructions */}
              <div className="px-6 py-5">
                <h4 className="text-sm font-semibold text-gray-900">Instructions</h4>
                <p className="mt-2 text-sm leading-relaxed text-gray-600 whitespace-pre-wrap">
                  {selectedAgent.instructions}
                </p>
              </div>

              {/* Context & Skills grid */}
              <div className="grid gap-0 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 divide-gray-100">
                {/* Context set */}
                <div className="px-6 py-5">
                  <h4 className="text-sm font-semibold text-gray-900">Context Set</h4>
                  <p className="mt-1 text-xs text-gray-500">
                    {selectedContextSet?.name || "Not attached"}
                  </p>
                  {selectedContextSet?.files.length ? (
                    <ul className="mt-3 space-y-1">
                      {selectedContextSet.files.map((file) => (
                        <li
                          key={file.id}
                          className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-1.5 text-xs"
                        >
                          <span className="min-w-0 truncate text-gray-700">
                            {file.relativePath}
                          </span>
                          <span className="ml-2 shrink-0 text-gray-400">
                            {formatBytes(file.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-gray-400">No context files attached.</p>
                  )}
                </div>

                {/* Skills */}
                <div className="px-6 py-5">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-sm font-semibold text-gray-900">Skills</h4>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAgentConfig(false);
                        openSkillsPage();
                      }}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
                    >
                      Manage
                    </button>
                  </div>
                  {selectedSkills.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedSkills.map((skill) => (
                        <span
                          key={skill.id}
                          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-600"
                        >
                          <IconBolt className="size-3 text-gray-400" />
                          {skill.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-gray-400">No skills attached.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
