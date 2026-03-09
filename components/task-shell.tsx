"use client";

import { FormEvent, startTransition, useEffect, useMemo, useState } from "react";

import type {
  ClientStatePayload,
  ContextSet,
  SkillBundle,
  Task,
  TaskArtifact,
} from "@/lib/types";

type StreamEvent =
  | { type: "status"; status: string }
  | { type: "update"; message: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "shell_output"; output: string }
  | { type: "done"; assistantText: string; responseId?: string; artifacts: TaskArtifact[] }
  | { type: "error"; message: string };

type RunState = {
  isRunning: boolean;
  assistantDraft: string;
  shellOutput: string;
  updates: string[];
  error?: string;
};

const directoryPickerProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function formatBytes(bytes: number | null) {
  if (bytes == null) {
    return "size unavailable";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function getJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);

  if (!response.ok) {
    const fallback = "Request failed";

    try {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error || fallback);
    } catch {
      throw new Error(fallback);
    }
  }

  return (await response.json()) as T;
}

export function TaskShell() {
  const [state, setState] = useState<ClientStatePayload | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [taskName, setTaskName] = useState("");
  const [contextSetName, setContextSetName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [prompt, setPrompt] = useState("");
  const [contextFiles, setContextFiles] = useState<File[]>([]);
  const [newSkillFiles, setNewSkillFiles] = useState<File[]>([]);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [runState, setRunState] = useState<RunState>({
    isRunning: false,
    assistantDraft: "",
    shellOutput: "",
    updates: [],
  });
  const [formError, setFormError] = useState<string | null>(null);

  const selectedTask = useMemo(
    () => state?.tasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, state],
  );
  const selectedContextSet = useMemo(
    () =>
      selectedTask
        ? state?.contextSets.find((contextSet) => contextSet.id === selectedTask.contextSetId) ?? null
        : null,
    [selectedTask, state],
  );

  async function refreshState(preferredTaskId?: string) {
    const nextState = await getJson<ClientStatePayload>("/api/state");
    setState(nextState);

    const availableTaskId =
      preferredTaskId ||
      (selectedTaskId && nextState.tasks.some((task) => task.id === selectedTaskId)
        ? selectedTaskId
        : nextState.tasks[0]?.id || null);

    setSelectedTaskId(availableTaskId);
  }

  useEffect(() => {
    void (async () => {
      try {
        await refreshState();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleCreateTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);

    try {
      if (!contextSetName.trim()) {
        throw new Error("Context set name is required.");
      }

      if (!instructions.trim()) {
        throw new Error("Agent instructions are required.");
      }

      if (!contextFiles.length) {
        throw new Error("Upload at least one context file or folder.");
      }

      const contextForm = new FormData();
      contextForm.set("name", contextSetName.trim());

      for (const file of contextFiles) {
        const relativeName = file.webkitRelativePath || file.name;
        contextForm.append("files", file, relativeName);
      }

      const contextSet = await getJson<ContextSet>("/api/context-sets", {
        method: "POST",
        body: contextForm,
      });

      const createdSkills: SkillBundle[] = [];

      for (const file of newSkillFiles) {
        const skillForm = new FormData();
        skillForm.set("file", file, file.name);
        const skill = await getJson<SkillBundle>("/api/skills", {
          method: "POST",
          body: skillForm,
        });
        createdSkills.push(skill);
      }

      const task = await getJson<Task>("/api/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: taskName.trim(),
          instructions: instructions.trim(),
          contextSetId: contextSet.id,
          skillIds: [...selectedSkillIds, ...createdSkills.map((skill) => skill.id)],
        }),
      });

      setTaskName("");
      setContextSetName("");
      setInstructions("");
      setPrompt("");
      setContextFiles([]);
      setNewSkillFiles([]);
      setSelectedSkillIds([]);

      startTransition(() => {
        void refreshState(task.id);
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to create task.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRunPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedTask || !prompt.trim()) {
      return;
    }

    setRunState({
      isRunning: true,
      assistantDraft: "",
      shellOutput: "",
      updates: ["Starting run..."],
    });

    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Streaming response failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const event = JSON.parse(line) as StreamEvent;

          if (event.type === "assistant_delta") {
            setRunState((current) => ({
              ...current,
              assistantDraft: current.assistantDraft + event.delta,
            }));
          }

          if (event.type === "update") {
            setRunState((current) => ({
              ...current,
              updates: [...current.updates, event.message],
            }));
          }

          if (event.type === "shell_output") {
            setRunState((current) => ({
              ...current,
              shellOutput: [current.shellOutput, event.output].filter(Boolean).join("\n\n"),
            }));
          }

          if (event.type === "error") {
            setRunState((current) => ({
              ...current,
              error: event.message,
            }));
          }

          if (event.type === "done") {
            setRunState((current) => ({
              ...current,
              isRunning: false,
              assistantDraft: event.assistantText,
              updates: [...current.updates, "Run complete."],
            }));

            startTransition(() => {
              void refreshState(selectedTask.id);
            });
          }
        }
      }

      setPrompt("");
      setRunState((current) => ({
        ...current,
        isRunning: false,
      }));
    } catch (error) {
      setRunState((current) => ({
        ...current,
        isRunning: false,
        error: error instanceof Error ? error.message : "Run failed.",
      }));
    }
  }

  if (loading || !state) {
    return <main className="screen loading-screen">Loading workspace...</main>;
  }

  return (
    <main className="screen">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-header">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            type="button"
          >
            {sidebarCollapsed ? ">" : "<"}
          </button>
          {!sidebarCollapsed ? <span className="sidebar-title">Agent Containers</span> : null}
        </div>

        <button
          className="new-task-button"
          onClick={() => {
            setSelectedTaskId(null);
            setPrompt("");
          }}
          type="button"
        >
          {sidebarCollapsed ? "+" : "New task"}
        </button>

        <div className="task-list">
          {state.tasks.map((task) => (
            <button
              className={`task-list-item ${selectedTaskId === task.id ? "active" : ""}`}
              key={task.id}
              onClick={() => setSelectedTaskId(task.id)}
              type="button"
            >
              <span className="task-name">{task.name}</span>
              {!sidebarCollapsed ? (
                <>
                  <span className={`task-status ${task.status}`}>{task.status}</span>
                  <span className="task-meta">
                    {task.messages.length} messages
                  </span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">Hosted shell workspace</p>
            <h1>{selectedTask ? selectedTask.name : "Create a new task"}</h1>
          </div>
          <div className="workspace-meta">
            <span>Model: {state.model}</span>
            <span className={state.hasOpenAIKey ? "key-ok" : "key-missing"}>
              {state.hasOpenAIKey ? "OPENAI_API_KEY configured" : "OPENAI_API_KEY missing"}
            </span>
          </div>
        </header>

        <div className="workspace-grid">
          <section className="panel">
            <div className="panel-heading">
              <h2>Task setup</h2>
              <p>Create a context set, attach optional skills, and register the agent.</p>
            </div>

            <form className="stack" onSubmit={handleCreateTask}>
              <label className="field">
                <span>Task name</span>
                <input
                  onChange={(event) => setTaskName(event.target.value)}
                  placeholder="Leave blank to auto-name with Agents SDK"
                  value={taskName}
                />
              </label>

              <label className="field">
                <span>Agent instructions</span>
                <textarea
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="Describe the kind of work this agent should do."
                  rows={5}
                  value={instructions}
                />
              </label>

              <label className="field">
                <span>Context set name</span>
                <input
                  onChange={(event) => setContextSetName(event.target.value)}
                  placeholder="Example: pricing-docs"
                  value={contextSetName}
                />
              </label>

              <label className="field">
                <span>Context files and folders</span>
                <input
                  multiple
                  onChange={(event) => setContextFiles(Array.from(event.target.files || []))}
                  type="file"
                  {...directoryPickerProps}
                />
                <small>{contextFiles.length} files selected</small>
              </label>

              <label className="field">
                <span>Upload skill bundles (.zip)</span>
                <input
                  accept=".zip"
                  multiple
                  onChange={(event) => setNewSkillFiles(Array.from(event.target.files || []))}
                  type="file"
                />
                <small>{newSkillFiles.length} skill bundles queued</small>
              </label>

              <div className="field">
                <span>Attach existing skills</span>
                <div className="skill-list">
                  {state.skills.length ? (
                    state.skills.map((skill) => {
                      const checked = selectedSkillIds.includes(skill.id);
                      return (
                        <label className="skill-chip" key={skill.id}>
                          <input
                            checked={checked}
                            onChange={(event) =>
                              setSelectedSkillIds((current) =>
                                event.target.checked
                                  ? [...current, skill.id]
                                  : current.filter((value) => value !== skill.id),
                              )
                            }
                            type="checkbox"
                          />
                          <span>{skill.name}</span>
                        </label>
                      );
                    })
                  ) : (
                    <small>No uploaded skill bundles yet.</small>
                  )}
                </div>
              </div>

              {formError ? <p className="error-text">{formError}</p> : null}

              <button className="primary-button" disabled={busy} type="submit">
                {busy ? "Creating..." : "Create task"}
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <h2>Prompt and conversation</h2>
              <p>Run work in the hosted container, watch updates, then continue the thread.</p>
            </div>

            {selectedTask ? (
              <>
                <dl className="task-facts">
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedTask.status}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDate(selectedTask.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Messages</dt>
                    <dd>{selectedTask.messages.length}</dd>
                  </div>
                  <div>
                    <dt>Artifacts</dt>
                    <dd>{selectedTask.artifacts.length}</dd>
                  </div>
                </dl>

                <form className="prompt-form" onSubmit={handleRunPrompt}>
                  <textarea
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Ask the agent to inspect the context set and do work."
                    rows={4}
                    value={prompt}
                  />
                  <button className="primary-button" disabled={runState.isRunning} type="submit">
                    {runState.isRunning ? "Running..." : "Send prompt"}
                  </button>
                </form>

                <div className="conversation">
                  {selectedTask.messages.map((message) => (
                    <article className={`message ${message.role}`} key={message.id}>
                      <span className="message-role">{message.role}</span>
                      <p>{message.content}</p>
                    </article>
                  ))}

                  {runState.assistantDraft ? (
                    <article className="message assistant live">
                      <span className="message-role">assistant</span>
                      <p>{runState.assistantDraft}</p>
                    </article>
                  ) : null}
                </div>

                <div className="live-grid">
                  <div className="log-panel">
                    <h3>Run updates</h3>
                    <div className="log-scroll">
                      {runState.updates.map((entry, index) => (
                        <p key={`${entry}-${index}`}>{entry}</p>
                      ))}
                      {runState.error ? <p className="error-text">{runState.error}</p> : null}
                    </div>
                  </div>

                  <div className="log-panel">
                    <h3>Shell output</h3>
                    <pre className="log-scroll shell-pre">
                      {runState.shellOutput || "No streamed shell output yet."}
                    </pre>
                  </div>
                </div>

                <div className="artifact-panel">
                  <div className="panel-heading compact">
                    <h3>Files in this task</h3>
                    <p>
                      Only files written to <code>/mnt/data</code> are offered as downloads.
                      Uploaded context files and intermediate container files stay separate.
                    </p>
                  </div>

                  <div className="file-buckets">
                    <section className="file-bucket">
                      <div className="bucket-header">
                        <h4>Downloadable outputs</h4>
                        <span>{selectedTask.artifacts.length}</span>
                      </div>
                      {selectedTask.artifacts.length ? (
                        <div className="artifact-list">
                          {selectedTask.artifacts.map((artifact) => (
                            <a
                              className="artifact-item downloadable"
                              href={`/api/tasks/${selectedTask.id}/artifacts/${artifact.id}`}
                              key={artifact.id}
                            >
                              <span>{artifact.path}</span>
                              <span>{formatBytes(artifact.bytes)}</span>
                            </a>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">
                          No files have been written to <code>/mnt/data</code> yet.
                        </p>
                      )}
                    </section>

                    <section className="file-bucket">
                      <div className="bucket-header">
                        <h4>Uploaded context files</h4>
                        <span>{selectedContextSet?.files.length ?? 0}</span>
                      </div>
                      {selectedContextSet?.files.length ? (
                        <div className="artifact-list">
                          {selectedContextSet.files.map((file) => (
                            <div className="artifact-item uploaded" key={file.id}>
                              <span>{file.relativePath}</span>
                              <span>{formatBytes(file.size)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">No context set is attached to this task.</p>
                      )}
                    </section>

                    <section className="file-bucket">
                      <div className="bucket-header">
                        <h4>Intermediate container files</h4>
                        <span>hidden</span>
                      </div>
                      <p className="muted">
                        Scratch files the agent creates outside <code>/mnt/data</code> are kept out
                        of the download list so users only see final deliverables.
                      </p>
                    </section>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <p>No task selected.</p>
                <p>Use the form on the left to upload a context set and create one.</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
