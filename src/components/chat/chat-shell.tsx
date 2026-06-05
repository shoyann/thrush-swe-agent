"use client";

import Image from "next/image";
import {
  FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentRequest,
  AgentSessionContext,
  AgentStep,
  AgentStreamEvent,
  ChatMessage,
} from "@/types/agent";
import type {
  ProjectSummary,
  SessionDetail,
  WorkbenchSnapshot,
} from "@/types/workbench";

const starterMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I am Thrush. Pick a project session, then give me a task for that workspace.",
  },
];

const starterSteps: AgentStep[] = [
  {
    id: "waiting",
    title: "Waiting for a task",
    detail: "The agent is idle until you send a message.",
    status: "idle",
  },
];

const loadingSteps: AgentStep[] = [
  {
    id: "perceive",
    title: "Perceive",
    detail: "Send the task to the backend API.",
    status: "running",
  },
  {
    id: "think",
    title: "Think",
    detail: "Wait for the backend agent loop to prepare a reply.",
    status: "idle",
  },
  {
    id: "act",
    title: "Act",
    detail: "The backend will answer here after it finishes.",
    status: "idle",
  },
];

const thinkingFragments = ["top", "right", "bottom", "left"] as const;
const agentApiSecret = process.env.NEXT_PUBLIC_AGENT_API_SECRET?.trim();

function apiHeaders(extraHeaders: Record<string, string> = {}) {
  return {
    ...extraHeaders,
    ...(agentApiSecret ? { Authorization: `Bearer ${agentApiSecret}` } : {}),
  };
}

type AgentErrorEvent = {
  message: string;
  type: "error";
};

async function readBackendErrorMessage(response: Response) {
  const fallbackMessage = `The backend API returned HTTP ${response.status}.`;

  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function getRequestFailureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "The request failed for an unknown reason.";
}

function parseStreamEvent(rawChunk: string) {
  const dataLine = rawChunk
    .split("\n")
    .find((line) => line.startsWith("data: "));

  if (!dataLine) {
    return null;
  }

  const payload = dataLine.slice("data: ".length).trim();
  if (!payload) {
    return null;
  }

  return JSON.parse(payload) as AgentStreamEvent | AgentErrorEvent;
}

function formatWorkspacePath(project: ProjectSummary | null) {
  return project?.workspacePath.replace(/\\/g, "/") ?? "No workspace selected";
}

function formatActiveWorkspacePath(
  project: ProjectSummary | null,
  sessionContext: AgentSessionContext,
) {
  const workspacePath =
    sessionContext.workspacePathOverride?.trim() || project?.workspacePath;

  return workspacePath?.replace(/\\/g, "/") ?? "No workspace selected";
}

export function ChatShell() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({
    activeSessionId: null,
    projects: [],
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetail | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);

  const activeProject = useMemo(() => {
    if (!activeSession) {
      return null;
    }

    return (
      snapshot.projects.find((project) => project.id === activeSession.projectId) ??
      null
    );
  }, [activeSession, snapshot.projects]);

  const messages = activeSession?.messages.length
    ? activeSession.messages
    : starterMessages;
  const steps = activeSession?.steps.length ? activeSession.steps : starterSteps;
  const sessionContext: AgentSessionContext =
    activeSession?.sessionContext ?? {};
  const pendingDraft = sessionContext.pendingDraft;
  const pendingWorkspaceSwitch = sessionContext.pendingWorkspaceSwitch;

  useEffect(() => {
    void loadWorkbench();
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null);
      return;
    }

    void loadSession(activeSessionId);
  }, [activeSessionId]);

  useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  async function loadWorkbench(selectSessionId?: string) {
    const response = await fetch("/api/projects", {
      headers: apiHeaders(),
    });
    if (!response.ok) {
      throw new Error(await readBackendErrorMessage(response));
    }

    const nextSnapshot = (await response.json()) as WorkbenchSnapshot;
    setSnapshot(nextSnapshot);
    setExpandedProjectIds(
      new Set(nextSnapshot.projects.map((project) => project.id)),
    );
    setActiveSessionId(selectSessionId ?? nextSnapshot.activeSessionId);
    setIsBooting(false);
  }

  async function loadSession(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      headers: apiHeaders(),
    });
    if (!response.ok) {
      throw new Error(await readBackendErrorMessage(response));
    }

    const payload = (await response.json()) as { session: SessionDetail };
    setActiveSession(payload.session);
  }

  function patchActiveSession(patch: Partial<SessionDetail>) {
    setActiveSession((current) => (current ? { ...current, ...patch } : current));
  }

  function applyStreamEvent(event: AgentStreamEvent | AgentErrorEvent) {
    if (event.type === "steps") {
      patchActiveSession({ steps: event.steps });
      return;
    }

    if (event.type === "message") {
      setActiveSession((current) =>
        current
          ? {
              ...current,
              messages: [...current.messages, event.message],
            }
          : current,
      );
      return;
    }

    if (event.type === "done") {
      patchActiveSession({ sessionContext: event.sessionContext });
      return;
    }

    throw new Error(event.message);
  }

  async function readAgentStream(response: Response) {
    if (!response.body) {
      throw new Error("The backend did not open a readable stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const event = parseStreamEvent(chunk);

        if (event) {
          applyStreamEvent(event);
        }
      }
    }

    const finalEvent = parseStreamEvent(buffer.trim());
    if (finalEvent) {
      applyStreamEvent(finalEvent);
    }
  }

  async function submitTask(task: string, displayTask = task) {
    const cleanTask = task.trim();
    const cleanDisplayTask = displayTask.trim();
    if (!cleanTask || !cleanDisplayTask || isLoading || !activeSession) {
      return;
    }

    const userMessage: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: cleanDisplayTask,
    };

    setActiveSession({
      ...activeSession,
      messages: [...activeSession.messages, userMessage],
      steps: loadingSteps,
    });
    setInput("");
    setIsLoading(true);

    try {
      const payload: AgentRequest = {
        sessionId: activeSession.id,
        stream: true,
        task: cleanTask,
      };
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: apiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(await readBackendErrorMessage(response));
      }

      await readAgentStream(response);
      await loadWorkbench(activeSession.id);
    } catch (error) {
      const errorMessage = getRequestFailureMessage(error);

      setActiveSession((current) =>
        current
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: `assistant-error-${Date.now()}`,
                  role: "assistant",
                  content: ["The request failed.", errorMessage].join("\n"),
                },
              ],
              steps: [
                {
                  id: "perceive",
                  title: "Perceive",
                  detail: `Tried to send the task "${cleanDisplayTask}" to the backend API.`,
                  status: "done",
                },
                {
                  id: "think",
                  title: "Think",
                  detail: `The request failed with this reason: ${errorMessage}`,
                  status: "done",
                },
                {
                  id: "act",
                  title: "Act",
                  detail: "Show an error message in the chat window.",
                  status: "done",
                },
              ],
            }
          : current,
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitTask(input);
  }

  async function handleDraftDecision(decision: "approve" | "cancel") {
    if (!pendingDraft) {
      return;
    }

    const task =
      decision === "approve"
        ? `APPROVE_WRITE ${pendingDraft.id}`
        : `CANCEL_WRITE ${pendingDraft.id}`;
    const displayTask = decision === "approve" ? "YES" : "NO";

    await submitTask(task, displayTask);
  }

  async function handleWorkspaceSwitchDecision(decision: "approve" | "cancel") {
    if (!pendingWorkspaceSwitch) {
      return;
    }

    const task =
      decision === "approve"
        ? `CONFIRM_WORKSPACE_SWITCH ${pendingWorkspaceSwitch.id}`
        : `CANCEL_WORKSPACE_SWITCH ${pendingWorkspaceSwitch.id}`;
    const displayTask = decision === "approve" ? "YES" : "NO";

    await submitTask(task, displayTask);
  }

  async function updateAutoApprove(autoApprove: boolean) {
    if (!activeSession || isLoading) {
      return;
    }

    const response = await fetch(`/api/sessions/${activeSession.id}/settings`, {
      method: "PATCH",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ autoApprove }),
    });

    if (!response.ok) {
      window.alert(await readBackendErrorMessage(response));
      return;
    }

    const payload = (await response.json()) as {
      session: SessionDetail;
      snapshot: WorkbenchSnapshot;
    };
    setSnapshot(payload.snapshot);
    setActiveSession(payload.session);
  }

  async function createProjectFromPrompt() {
    if (isLoading) {
      return;
    }

    const workspacePath = window.prompt(
      "Enter the absolute folder path for this project workspace.",
    );
    if (!workspacePath?.trim()) {
      return;
    }

    const name =
      window.prompt("Project name", workspacePath.trim().split(/[\\/]/).pop()) ??
      "New project";

    const confirmed = window.confirm(
      `Confirm this workspace path?\n\n${workspacePath.trim()}\n\nAgent tools will be limited to this folder.`,
    );
    if (!confirmed) {
      return;
    }

    const response = await fetch("/api/projects", {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        confirmWorkspace: true,
        name,
        workspacePath,
      }),
    });

    if (!response.ok) {
      window.alert(await readBackendErrorMessage(response));
      return;
    }

    const payload = (await response.json()) as WorkbenchSnapshot & {
      snapshot?: WorkbenchSnapshot;
    };
    const nextSnapshot = payload.snapshot ?? payload;
    const createdSessionId =
      nextSnapshot.projects[0]?.sessions[0]?.id ?? nextSnapshot.activeSessionId;

    setSnapshot(nextSnapshot);
    setActiveSessionId(createdSessionId ?? null);
  }

  async function createSessionForProject(projectId: string) {
    if (isLoading) {
      return;
    }

    const response = await fetch(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "New session" }),
    });

    if (!response.ok) {
      window.alert(await readBackendErrorMessage(response));
      return;
    }

    const payload = (await response.json()) as {
      session: SessionDetail;
      snapshot: WorkbenchSnapshot;
    };
    setSnapshot(payload.snapshot);
    setActiveSessionId(payload.session.id);
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);

      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }

      return next;
    });
  }

  function selectSession(sessionId: string) {
    if (isLoading || sessionId === activeSessionId) {
      return;
    }

    setActiveSessionId(sessionId);
  }

  return (
    <main className="app-shell">
      <header className="brand-bar" aria-label="Thrush brand">
        <div className="brand-mark-wrap">
          <Image
            src="/icon.png"
            alt="Thrush icon"
            width={44}
            height={44}
            className="brand-mark"
            priority
          />
        </div>
        <div className="brand-copy">
          <p className="brand-name">Thrush</p>
          <p className="brand-tagline">Project session workbench</p>
        </div>
      </header>

      <section className="workbench-grid">
        <aside className="panel sidebar-panel">
          <div className="sidebar-header">
            <div>
              <p className="panel-kicker">Projects</p>
              <h2>Workspaces</h2>
            </div>
            <button
              className="small-button"
              type="button"
              disabled={isLoading}
              onClick={() => void createProjectFromPrompt()}
            >
              + Project
            </button>
          </div>

          <div className="project-list">
            {snapshot.projects.map((project) => {
              const isExpanded = expandedProjectIds.has(project.id);

              return (
                <article key={project.id} className="project-group">
                  <button
                    className="project-row"
                    type="button"
                    disabled={isLoading}
                    onClick={() => toggleProject(project.id)}
                  >
                    <span>{isExpanded ? "v" : ">"}</span>
                    <span className="project-title">{project.name}</span>
                  </button>
                  <p className="workspace-path">{formatWorkspacePath(project)}</p>

                  {isExpanded ? (
                    <div className="session-list">
                      {project.sessions.map((session) => (
                        <button
                          key={session.id}
                          className={`session-row ${
                            session.id === activeSessionId ? "active" : ""
                          }`}
                          type="button"
                          disabled={isLoading}
                          onClick={() => selectSession(session.id)}
                        >
                          {session.title}
                        </button>
                      ))}

                      <button
                        className="new-session-button"
                        type="button"
                        disabled={isLoading}
                        onClick={() => void createSessionForProject(project.id)}
                      >
                        + Session
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </aside>

        <section className="panel chat-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Chat</p>
              <h2>{activeSession?.title ?? "No session"}</h2>
              <p className="session-subtitle">
                {formatActiveWorkspacePath(activeProject, sessionContext)}
                {sessionContext.readOnly ? " | read-only" : ""}
                {sessionContext.autoApprove ? " | autoApprove on" : " | autoApprove off"}
              </p>
            </div>
            {activeSession ? (
              <button
                className="small-button"
                type="button"
                disabled={isLoading || sessionContext.readOnly === true}
                onClick={() => void updateAutoApprove(!sessionContext.autoApprove)}
              >
                {sessionContext.autoApprove ? "Disable autoApprove" : "Enable autoApprove"}
              </button>
            ) : null}
          </div>

          <div ref={messageViewportRef} className="message-viewport">
            <div className="message-list">
              {isBooting ? (
                <article className="message-bubble assistant">
                  <p className="message-role">assistant</p>
                  <p>Loading workbench...</p>
                </article>
              ) : (
                messages.map((message) => (
                  <article
                    key={message.id}
                    className={`message-bubble ${message.role}`}
                  >
                    <p className="message-role">{message.role}</p>
                    <p>{message.content}</p>
                  </article>
                ))
              )}

              {isLoading ? (
                <article className="message-bubble assistant thinking-bubble">
                  <p className="message-role">assistant</p>
                  <div className="thinking-shell" aria-label="Thrush is thinking">
                    <div className="thinking-prism-container">
                      {thinkingFragments.map((fragment) => (
                        <span
                          key={fragment}
                          className={`prism-fragment ${fragment}`}
                        />
                      ))}
                    </div>
                    <div className="thinking-copy">
                      <strong>Thinking</strong>
                      <span>Gathering context and shaping the next step.</span>
                    </div>
                  </div>
                </article>
              ) : null}
            </div>
          </div>

          {pendingDraft ? (
            <div className="draft-decision-panel">
              <p className="draft-decision-copy">
                Pending draft for <strong>{pendingDraft.path}</strong>
              </p>
              <div className="draft-decision-row">
                <button
                  className="decision-button yes"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleDraftDecision("approve")}
                >
                  YES
                </button>
                <button
                  className="decision-button no"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleDraftDecision("cancel")}
                >
                  NO
                </button>
              </div>
            </div>
          ) : null}

          {pendingWorkspaceSwitch ? (
            <div className="draft-decision-panel">
              <p className="draft-decision-copy">
                Switch this session to{" "}
                <strong>{pendingWorkspaceSwitch.workspacePath}</strong>
                {pendingWorkspaceSwitch.readOnly ? " in read-only mode" : ""}?
              </p>
              <div className="draft-decision-row">
                <button
                  className="decision-button yes"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleWorkspaceSwitchDecision("approve")}
                >
                  YES
                </button>
                <button
                  className="decision-button no"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleWorkspaceSwitchDecision("cancel")}
                >
                  NO
                </button>
              </div>
            </div>
          ) : null}

          <form className="composer" onSubmit={handleSubmit}>
            <label className="composer-label" htmlFor="task-input">
              Describe the task you want the agent to do
            </label>
            <div className="composer-row">
              <textarea
                id="task-input"
                className="composer-input"
                rows={3}
                disabled={isLoading || !activeSession}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Example: read the README, then summarize it."
              />
              <button
                className="composer-button"
                type="submit"
                disabled={isLoading || !activeSession}
              >
                {isLoading ? "Sending..." : "Send task"}
              </button>
            </div>
          </form>
        </section>

        <aside className="panel trace-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Agent Trace</p>
              <h2>{"Perceive -> Think -> Act"}</h2>
            </div>
          </div>

          <div className="step-list">
            {steps.map((step) => (
              <article key={step.id} className={`step-card ${step.status}`}>
                <div className="step-card-content">
                  <div className="step-topline">
                    <h3>{step.title}</h3>
                    <span className={`step-status ${step.status}`}>
                      {step.status === "running" ? (
                        <span className="badge-node-container" aria-hidden="true">
                          <span className="badge-node" />
                          <span className="badge-node" />
                          <span className="badge-node" />
                        </span>
                      ) : (
                        <span className="step-status-dot" aria-hidden="true" />
                      )}
                      {step.status}
                    </span>
                  </div>
                  <p>{step.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
