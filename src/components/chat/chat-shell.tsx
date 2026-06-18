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
  AutoArtifact,
  AutoArtifactType,
  AutoEvent,
  AutoReadiness,
  AutoRun,
  AutoRunDetail,
} from "@/types/auto";
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
const autoArtifactTabs: AutoArtifactType[] = [
  "report",
  "diff",
  "logs",
  "trajectory",
  "changed_files",
];
const agentApiSecret = process.env.NEXT_PUBLIC_AGENT_API_SECRET?.trim();

type AgentErrorEvent = {
  message: string;
  type: "error";
};

type WorkbenchMode = "assist" | "auto";

async function readBackendErrorMessage(response: Response) {
  const fallbackMessage = `The backend API returned HTTP ${response.status}.`;

  try {
    const payload = (await response.json()) as { detail?: unknown; error?: unknown };
    const error = typeof payload.error === "string" ? payload.error.trim() : "";
    const detail = typeof payload.detail === "string" ? payload.detail.trim() : "";

    return [error || fallbackMessage, detail].filter(Boolean).join("\n");
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

function isActiveAutoRun(run: AutoRun | null) {
  return (
    run?.status === "queued" ||
    run?.status === "preparing" ||
    run?.status === "running" ||
    run?.status === "reporting"
  );
}

function getArtifact(detail: AutoRunDetail | null, type: AutoArtifactType) {
  return detail?.artifacts.find((artifact) => artifact.type === type) ?? null;
}

function formatArtifactContent(artifact: AutoArtifact | null) {
  if (!artifact) {
    return "No artifact was recorded yet.";
  }

  if (artifact.contentText?.trim()) {
    return artifact.contentText;
  }

  if (artifact.filePath) {
    return `This artifact is stored on disk:\n${artifact.filePath}`;
  }

  return "This artifact is empty.";
}

function formatReportPreview(content: string) {
  return content
    .replace(/^# Auto Report\s*/i, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*-\s*/gm, "- ")
    .trim();
}

function eventStatus(event: AutoEvent) {
  if (
    event.type === "completed" ||
    event.type === "failed" ||
    event.type === "canceled"
  ) {
    return "done";
  }

  return "running";
}

export function ChatShell() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({
    activeSessionId: null,
    projects: [],
  });
  const [mode, setMode] = useState<WorkbenchMode>("assist");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionDetail | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isProjectFormOpen, setIsProjectFormOpen] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [projectFormError, setProjectFormError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [autoTask, setAutoTask] = useState("");
  const [autoRuns, setAutoRuns] = useState<AutoRun[]>([]);
  const [activeAutoRunId, setActiveAutoRunId] = useState<string | null>(null);
  const [activeAutoRunDetail, setActiveAutoRunDetail] =
    useState<AutoRunDetail | null>(null);
  const [autoReadiness, setAutoReadiness] = useState<AutoReadiness | null>(null);
  const [autoArtifactTab, setAutoArtifactTab] =
    useState<AutoArtifactType>("report");
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [isAutoReadinessLoading, setIsAutoReadinessLoading] = useState(false);
  const [isAutoSubmitting, setIsAutoSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isBooting, setIsBooting] = useState(true);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);

  const activeProject = useMemo(
    () =>
      snapshot.projects.find((project) => project.id === activeProjectId) ??
      null,
    [activeProjectId, snapshot.projects],
  );
  const activeAutoRun = activeAutoRunDetail?.run ?? null;
  const blockingAutoCheck =
    autoReadiness?.checks.find((check) => check.required && !check.ok) ?? null;
  const githubReadiness =
    autoReadiness?.checks.find((check) => check.name === "github") ?? null;
  const canCreateDraftPr =
    activeAutoRun?.status === "completed" && githubReadiness?.ok === true;
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

  useEffect(() => {
    if (!activeProjectId) {
      setAutoReadiness(null);
      return;
    }

    void loadAutoRuns(activeProjectId);
    void loadAutoReadiness(activeProjectId);
  }, [activeProjectId]);

  useEffect(() => {
    if (mode !== "auto" || !activeProjectId) {
      return;
    }

    void loadAutoReadiness(activeProjectId);
  }, [activeProjectId, mode]);

  useEffect(() => {
    if (!activeAutoRunId) {
      setActiveAutoRunDetail(null);
      return;
    }

    void loadAutoRunDetail(activeAutoRunId);
  }, [activeAutoRunId]);

  useEffect(() => {
    if (mode !== "auto" || !activeProjectId) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadAutoRuns(activeProjectId, activeAutoRunId);
      if (activeAutoRunId) {
        void loadAutoRunDetail(activeAutoRunId);
      }
    }, 2500);

    return () => window.clearInterval(interval);
  }, [activeAutoRunId, activeProjectId, mode]);

  useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  async function loadWorkbench(selectSessionId?: string) {
    const response = await fetch("/api/projects");
    if (!response.ok) {
      throw new Error(await readBackendErrorMessage(response));
    }

    const nextSnapshot = (await response.json()) as WorkbenchSnapshot;
    const nextSessionId = selectSessionId ?? nextSnapshot.activeSessionId;
    const nextProject =
      nextSnapshot.projects.find((project) =>
        project.sessions.some((session) => session.id === nextSessionId),
      ) ?? nextSnapshot.projects[0] ?? null;

    setSnapshot(nextSnapshot);
    setExpandedProjectIds(
      new Set(nextSnapshot.projects.map((project) => project.id)),
    );
    setActiveProjectId((current) => current ?? nextProject?.id ?? null);
    setActiveSessionId(nextSessionId);
    setIsBooting(false);
  }

  async function loadSession(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) {
      throw new Error(await readBackendErrorMessage(response));
    }

    const payload = (await response.json()) as { session: SessionDetail };
    setActiveSession(payload.session);
    setActiveProjectId(payload.session.projectId);
  }

  async function loadAutoRuns(projectId: string, preferRunId?: string | null) {
    const response = await fetch(`/api/auto-runs?projectId=${projectId}`);
    if (!response.ok) {
      setAutoError(await readBackendErrorMessage(response));
      return;
    }

    const payload = (await response.json()) as { runs: AutoRun[] };
    setAutoRuns(payload.runs);
    setAutoError(null);

    const nextRunId =
      preferRunId && payload.runs.some((run) => run.id === preferRunId)
        ? preferRunId
        : payload.runs[0]?.id ?? null;

    setActiveAutoRunId((current) => current ?? nextRunId);
  }

  async function loadAutoRunDetail(autoRunId: string) {
    const response = await fetch(`/api/auto-runs/${autoRunId}`);
    if (!response.ok) {
      setAutoError(await readBackendErrorMessage(response));
      return;
    }

    setActiveAutoRunDetail((await response.json()) as AutoRunDetail);
    setAutoError(null);
  }

  async function loadAutoReadiness(projectId: string) {
    setIsAutoReadinessLoading(true);

    try {
      const response = await fetch(
        `/api/auto-runs/readiness?projectId=${encodeURIComponent(projectId)}`,
      );

      if (!response.ok) {
        setAutoReadiness(null);
        setAutoError(await readBackendErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as { readiness: AutoReadiness };
      setAutoReadiness(payload.readiness);
    } finally {
      setIsAutoReadinessLoading(false);
    }
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
        headers: {
          "Content-Type": "application/json",
          ...(agentApiSecret
            ? { Authorization: `Bearer ${agentApiSecret}` }
            : {}),
        },
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

  async function handleAutoSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTask = autoTask.trim();

    if (!activeProject || !cleanTask || isAutoSubmitting) {
      return;
    }

    if (blockingAutoCheck) {
      setAutoError(blockingAutoCheck.message);
      return;
    }

    setIsAutoSubmitting(true);
    setAutoError(null);

    try {
      const response = await fetch("/api/auto-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProject.id,
          sourceSessionId: activeSessionId,
          task: cleanTask,
        }),
      });

      if (!response.ok) {
        throw new Error(await readBackendErrorMessage(response));
      }

      const payload = (await response.json()) as { run: AutoRun };
      setAutoTask("");
      setActiveAutoRunId(payload.run.id);
      await loadAutoRuns(activeProject.id, payload.run.id);
      await loadAutoRunDetail(payload.run.id);
      await loadAutoReadiness(activeProject.id);
    } catch (error) {
      setAutoError(getRequestFailureMessage(error));
    } finally {
      setIsAutoSubmitting(false);
    }
  }

  async function handleAutoCancel() {
    if (!activeAutoRun) {
      return;
    }

    const response = await fetch(`/api/auto-runs/${activeAutoRun.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "User canceled from the Auto UI." }),
    });

    if (!response.ok) {
      setAutoError(await readBackendErrorMessage(response));
      return;
    }

    await loadAutoRunDetail(activeAutoRun.id);
  }

  async function handleCreateDraftPr() {
    if (!activeAutoRun) {
      return;
    }

    const response = await fetch(
      `/api/auto-runs/${activeAutoRun.id}/create-draft-pr`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      setAutoError(await readBackendErrorMessage(response));
      return;
    }

    await loadAutoRunDetail(activeAutoRun.id);
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

  function openProjectForm() {
    if (isLoading) {
      return;
    }

    setProjectFormError(null);
    setIsProjectFormOpen(true);
  }

  async function handleProjectFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workspacePath = newProjectPath.trim();
    const name =
      newProjectName.trim() || workspacePath.split(/[\\/]/).filter(Boolean).pop();

    if (!workspacePath) {
      setProjectFormError("Workspace path is required.");
      return;
    }

    setIsCreatingProject(true);
    setProjectFormError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmWorkspace: true,
          name: name ?? "New project",
          workspacePath,
        }),
      });

      if (!response.ok) {
        setProjectFormError(await readBackendErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as WorkbenchSnapshot & {
        snapshot?: WorkbenchSnapshot;
      };
      const nextSnapshot = payload.snapshot ?? payload;
      const createdProject = nextSnapshot.projects[0] ?? null;
      const createdSessionId =
        createdProject?.sessions[0]?.id ?? nextSnapshot.activeSessionId;

      setSnapshot(nextSnapshot);
      setActiveProjectId(createdProject?.id ?? null);
      setActiveSessionId(createdSessionId ?? null);
      setExpandedProjectIds(
        new Set(nextSnapshot.projects.map((project) => project.id)),
      );
      setIsProjectFormOpen(false);
      setNewProjectName("");
      setNewProjectPath("");
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function createSessionForProject(projectId: string) {
    if (isLoading) {
      return;
    }

    const response = await fetch(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    setActiveProjectId(payload.session.projectId);
    setActiveSessionId(payload.session.id);
    setMode("assist");
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
    setActiveProjectId(projectId);
  }

  function selectSession(sessionId: string) {
    if (isLoading || sessionId === activeSessionId) {
      return;
    }

    setActiveSessionId(sessionId);
    setMode("assist");
  }

  function renderAssistPanel() {
    return (
      <section className="panel chat-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Assist</p>
            <h2>{activeSession?.title ?? "No session"}</h2>
            <p className="session-subtitle">
              {formatActiveWorkspacePath(activeProject, sessionContext)}
              {sessionContext.readOnly ? " | read-only" : ""}
            </p>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={() => setIsDetailsOpen(true)}
          >
            Details
          </button>
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
    );
  }

  function renderAutoPanel() {
    const reportArtifact = getArtifact(activeAutoRunDetail, "report");
    const reportContent = formatReportPreview(formatArtifactContent(reportArtifact));
    const startDisabled =
      !activeProject ||
      !autoTask.trim() ||
      isAutoSubmitting ||
      isAutoReadinessLoading ||
      !autoReadiness ||
      Boolean(blockingAutoCheck);
    const draftPrDisabledReason =
      activeAutoRun?.status !== "completed"
        ? "Draft PR is available after Auto completes."
        : githubReadiness?.ok === false
          ? githubReadiness.message
          : "";

    return (
      <section className="panel auto-panel">
        <div className="panel-header auto-header">
          <div>
            <p className="panel-kicker">Auto</p>
            <h2>{activeProject?.name ?? "No project selected"}</h2>
            <p className="session-subtitle">
              Auto works in an isolated copy and will not directly change your
              main project.
            </p>
          </div>
          {activeAutoRun ? (
            <span className={`auto-status ${activeAutoRun.status}`}>
              {activeAutoRun.status}
            </span>
          ) : null}
        </div>

        <form className="auto-create" onSubmit={handleAutoSubmit}>
          <textarea
            className="composer-input auto-task-input"
            disabled={!activeProject || isAutoSubmitting}
            value={autoTask}
            onChange={(event) => setAutoTask(event.target.value)}
            placeholder="Example: fix the failing login test and verify the result."
          />
          <button
            className="composer-button auto-start-button"
            type="submit"
            disabled={startDisabled}
            title={blockingAutoCheck?.message}
          >
            {isAutoSubmitting
              ? "Starting..."
              : isAutoReadinessLoading
                ? "Checking..."
                : "Start Auto"}
          </button>
        </form>

        <div className="auto-readiness">
          <div className="auto-readiness-summary">
            <div>
              <p className="auto-section-title">Recommended Environment</p>
              <strong>
                {autoReadiness
                  ? `${autoReadiness.environment ?? "docker"} / ${
                      autoReadiness.environmentKind ?? "generic"
                    }`
                  : "Checking"}
              </strong>
              <span>
                {autoReadiness?.dockerImage
                  ? `Image: ${autoReadiness.dockerImage}`
                  : "Auto will choose a practical environment for this project."}
              </span>
            </div>
            <p>{autoReadiness?.message ?? "Checking Auto requirements..."}</p>
          </div>

          <div className="auto-check-list">
            {autoReadiness?.checks.map((check) => (
              <div
                key={check.name}
                className={`auto-check ${
                  check.ok ? "ok" : check.required ? "blocked" : "later"
                }`}
              >
                <span>{check.ok ? "OK" : check.required ? "Required" : "Later"}</span>
                <strong>{check.name}</strong>
                <p>{check.message}</p>
              </div>
            )) ?? (
              <div className="auto-check">
                <span>Checking</span>
                <strong>environment</strong>
                <p>Thrush is checking Docker, mini-swe-agent, model config, and Git.</p>
              </div>
            )}
          </div>
        </div>

        {autoError ? <div className="auto-error">{autoError}</div> : null}

        <div className="auto-result">
          {activeAutoRun ? (
            <>
              <div className="auto-result-main">
                <p className="auto-section-title">Result</p>
                <h3>
                  {activeAutoRun.status === "completed"
                    ? "Completed"
                    : activeAutoRun.status === "failed"
                      ? "Needs review"
                      : activeAutoRun.status}
                </h3>
                <p>
                  {activeAutoRun.status === "completed"
                    ? "Thrush prepared changes in an isolated copy. Review them before applying or opening a PR."
                    : activeAutoRun.status === "failed"
                      ? activeAutoRun.failureMessage ??
                        "Auto could not finish this run. Open details for logs and trajectory."
                      : activeAutoRun.status === "canceled"
                        ? "This run was stopped before it finished. Open details if you want to inspect the trace."
                        : "Auto is working in an isolated copy of your project."}
                </p>
              </div>

              <div className="auto-report-card">
                <p className="auto-section-title">Report</p>
                <pre>{reportContent}</pre>
              </div>

              <div className="auto-actions">
                <button
                  className="small-button secondary"
                  type="button"
                  disabled={!isActiveAutoRun(activeAutoRun)}
                  onClick={() => void handleAutoCancel()}
                >
                  Cancel
                </button>
                <button
                  className="small-button"
                  type="button"
                  onClick={() => {
                    setAutoArtifactTab("diff");
                    setIsDetailsOpen(true);
                  }}
                >
                  Review changes
                </button>
                <button
                  className="small-button"
                  type="button"
                  disabled={!canCreateDraftPr}
                  title={draftPrDisabledReason}
                  onClick={() => void handleCreateDraftPr()}
                >
                  Create Draft PR
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setIsDetailsOpen(true)}
                >
                  Details
                </button>
              </div>
            </>
          ) : (
            <p className="empty-copy">
              Start an Auto Run. Thrush will report back with the result, files,
              diff, logs, and next steps.
            </p>
          )}
        </div>

        <div className="auto-run-list">
          <div className="auto-section-title">Recent runs</div>
          {autoRuns.length === 0 ? (
            <p className="empty-copy">No Auto Runs yet.</p>
          ) : (
            autoRuns.map((run) => (
              <button
                key={run.id}
                className={`auto-run-row ${
                  run.id === activeAutoRunId ? "active" : ""
                }`}
                type="button"
                onClick={() => setActiveAutoRunId(run.id)}
              >
                <strong>{run.task}</strong>
                <span>{run.status}</span>
              </button>
            ))
          )}
        </div>
      </section>
    );
  }

  function renderDetailsDrawer() {
    if (mode === "auto") {
      const events = activeAutoRunDetail?.events ?? [];
      const selectedArtifact = getArtifact(activeAutoRunDetail, autoArtifactTab);

      return (
        <aside className="details-drawer" aria-label="Run details">
          <div className="details-header">
            <div>
              <p className="panel-kicker">Run Details</p>
              <h2>Auto evidence</h2>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setIsDetailsOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="artifact-tabs">
            {autoArtifactTabs.map((tab) => (
              <button
                key={tab}
                className={tab === autoArtifactTab ? "active" : ""}
                type="button"
                onClick={() => setAutoArtifactTab(tab)}
              >
                {tab === "trajectory" ? "technical details" : tab.replace("_", " ")}
              </button>
            ))}
          </div>

          <pre className="artifact-viewer">
            {formatArtifactContent(selectedArtifact)}
          </pre>

          <div className="step-list">
            <p className="auto-section-title">Timeline</p>
            {events.length === 0 ? (
              <article className="step-card idle">
                <div className="step-card-content">
                  <h3>Waiting</h3>
                  <p>No Auto Run selected yet.</p>
                </div>
              </article>
            ) : (
              events.map((event) => (
                <article
                  key={event.id}
                  className={`step-card ${eventStatus(event)}`}
                >
                  <div className="step-card-content">
                    <div className="step-topline">
                      <h3>{event.type.replaceAll("_", " ")}</h3>
                      <span className={`step-status ${eventStatus(event)}`}>
                        <span className="step-status-dot" aria-hidden="true" />
                        {eventStatus(event)}
                      </span>
                    </div>
                    <p>{event.message}</p>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      );
    }

    return (
      <aside className="details-drawer" aria-label="Agent details">
        <div className="details-header">
          <div>
            <p className="panel-kicker">Agent Details</p>
            <h2>Assist trace</h2>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={() => setIsDetailsOpen(false)}
          >
            Close
          </button>
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
    );
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
          <p className="brand-tagline">
            {activeProject?.name ?? "Local SWE agent workbench"}
          </p>
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
              onClick={openProjectForm}
            >
              + Project
            </button>
          </div>

          {isProjectFormOpen ? (
            <form className="project-create-form" onSubmit={handleProjectFormSubmit}>
              <label>
                <span>Workspace path</span>
                <input
                  autoFocus
                  disabled={isCreatingProject}
                  onChange={(event) => setNewProjectPath(event.target.value)}
                  placeholder="/home/yann/codex-projects/my-project"
                  value={newProjectPath}
                />
              </label>
              <label>
                <span>Project name</span>
                <input
                  disabled={isCreatingProject}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  placeholder="Optional"
                  value={newProjectName}
                />
              </label>
              {projectFormError ? (
                <p className="project-create-error">{projectFormError}</p>
              ) : (
                <p className="project-create-note">
                  Agent tools will be limited to this folder.
                </p>
              )}
              <div className="project-create-actions">
                <button
                  className="small-button"
                  disabled={isCreatingProject}
                  type="submit"
                >
                  {isCreatingProject ? "Adding..." : "Add"}
                </button>
                <button
                  className="small-button secondary"
                  disabled={isCreatingProject}
                  type="button"
                  onClick={() => setIsProjectFormOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          <div className="project-list">
            {snapshot.projects.map((project) => {
              const isExpanded = expandedProjectIds.has(project.id);

              return (
                <article key={project.id} className="project-group">
                  <button
                    className={`project-row ${
                      project.id === activeProjectId ? "active" : ""
                    }`}
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
                            session.id === activeSessionId && mode === "assist"
                              ? "active"
                              : ""
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

        <div className="workspace-main">
          <div className="workspace-toolbar">
            <div className="mode-tabs" role="tablist" aria-label="Workbench mode">
              <button
                className={mode === "assist" ? "active" : ""}
                type="button"
                onClick={() => setMode("assist")}
              >
                Assist
              </button>
              <button
                className={mode === "auto" ? "active" : ""}
                type="button"
                onClick={() => setMode("auto")}
              >
                Auto
              </button>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={() => setIsDetailsOpen(true)}
            >
              Details
            </button>
          </div>

          {mode === "assist" ? renderAssistPanel() : renderAutoPanel()}
        </div>
      </section>

      {isDetailsOpen ? (
        <>
          <button
            className="drawer-scrim"
            type="button"
            aria-label="Close details"
            onClick={() => setIsDetailsOpen(false)}
          />
          {renderDetailsDrawer()}
        </>
      ) : null}
    </main>
  );
}
