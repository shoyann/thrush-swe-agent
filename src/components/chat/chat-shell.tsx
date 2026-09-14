"use client";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bird,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  Folder,
  FolderPlus,
  GitBranch,
  History,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { DesktopState } from "@/types/desktop";
import type { AutoArtifactType } from "@/types/auto";
import { useWorkbench } from "../workbench/use-workbench";
import { Markdown, DiffView } from "../workbench/markdown";
import { Dialog } from "../workbench/dialog";
import { Composer } from "../workbench/composer";
import {
  DesktopSettingsPanel,
  DirectoryPicker,
} from "../workbench/desktop-settings";
import { errorText } from "../workbench/api";
const suggestions = [
  {
    icon: Code2,
    title: "Understand this project",
    task: "Explore this project's structure and explain how its main components work.",
  },
  {
    icon: ShieldCheck,
    title: "Find a bug",
    task: "Review this project for a concrete bug. Explain the issue and propose a focused fix.",
  },
  {
    icon: Sparkles,
    title: "Build something new",
    task: "Read the README and suggest a useful, small feature we could build next.",
  },
];
const tabs: { id: AutoArtifactType; label: string }[] = [
  { id: "report", label: "Report" },
  { id: "diff", label: "Diff" },
  { id: "changed_files", label: "Files" },
  { id: "logs", label: "Logs" },
  { id: "trajectory", label: "Technical" },
];
const isRunning = (s?: string) =>
  Boolean(s && ["queued", "preparing", "running", "reporting"].includes(s));
export function ChatShell() {
  const w = useWorkbench();
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [settings, setSettings] = useState(false);
  const [addProject, setAddProject] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectError, setProjectError] = useState("");
  const [adding, setAdding] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [review, setReview] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<AutoArtifactType>("report");
  const [input, setInput] = useState("");
  const [autoInput, setAutoInput] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const project = w.project;
  const session = w.session;
  const run = w.detail?.run;
  useEffect(() => {
    const api = window.thrushDesktop;
    if (!api) return;
    void api.getState().then((s) => {
      setDesktop(s);
      if (!s.settings.configured || sessionStorage.getItem("thrush-setup-step"))
        setSettings(true);
    });
    return api.onState(setDesktop);
  }, []);
  const previousSession = useRef<string | null>(null);
  useEffect(() => {
    if (session?.id && previousSession.current !== session.id) {
      previousSession.current = session.id;
      setInput("");
      setAtBottom(true);
    }
  }, [session?.id]);
  useEffect(() => {
    if (atBottom && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [session?.messages, w.busy, atBottom]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setReview(false);
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const pending = session?.sessionContext.pendingDraft;
  const pendingSwitch = session?.sessionContext.pendingWorkspaceSwitch;
  const artifact = w.detail?.artifacts.find((a) => a.type === tab);
  const report = w.detail?.artifacts.find((a) => a.type === "report");
  const envLabel =
    desktop?.settings.environment === "wsl"
      ? desktop.settings.distribution
      : desktop
        ? "Windows"
        : "Local workspace";
  const openReview = (next: AutoArtifactType = "report") => {
    setTab(next);
    setReview(true);
  };
  async function submit() {
    if (w.mode === "assist") {
      const value = input;
      setInput("");
      if (!(await w.send(value))) setInput(value);
    } else {
      if (await w.startAuto(autoInput)) setAutoInput("");
    }
  }
  const trace = (
    <div className="trace">
      {w.mode === "assist" ? (
        session?.steps.length ? (
          session.steps.map((step) => (
            <div className="trace-step" key={step.id}>
              <span className={"status-dot " + step.status} />
              <div>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">Steps will appear when your task starts.</p>
        )
      ) : w.detail?.events.length ? (
        w.detail.events.map((event) => (
          <div className="trace-step" key={event.id}>
            <span className="status-dot done" />
            <div>
              <strong>{event.type.replaceAll("_", " ")}</strong>
              <p>{event.message}</p>
              <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">No events recorded yet.</p>
      )}
    </div>
  );
  const reviewContent = (
    <>
      <div className="review-heading">
        <div>
          <p className="eyebrow">
            {w.mode === "assist" ? "ASSIST ACTIVITY" : "RUN ARTIFACTS"}
          </p>
          <h2>
            {w.mode === "assist" ? "Behind the task" : "Review the result"}
          </h2>
        </div>
        <div className="actions">
          <button
            className="icon-button"
            aria-label="Expand review"
            onClick={() => setExpanded(!expanded)}
          >
            <Maximize2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Close review"
            onClick={() => {
              setReview(false);
              setExpanded(false);
            }}
          >
            <X size={18} />
          </button>
        </div>
      </div>
      {w.mode === "auto" && (
        <>
          <div
            className="artifact-tabs"
            role="tablist"
            aria-label="Run artifacts"
          >
            {tabs.map((t) => (
              <button
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
                key={t.id}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="artifact-content">
            {artifact?.contentText ? (
              tab === "report" ? (
                <Markdown text={artifact.contentText} />
              ) : tab === "diff" ? (
                <DiffView text={artifact.contentText} />
              ) : (
                <pre>{artifact.contentText}</pre>
              )
            ) : (
              <div className="artifact-empty">
                <FileCode2 size={26} />
                <h3>
                  {artifact?.filePath ? "Stored on disk" : "Nothing here yet"}
                </h3>
                <p>
                  {artifact?.filePath ||
                    "This artifact will appear when the run produces it."}
                </p>
              </div>
            )}
          </div>
          <details className="timeline-details">
            <summary>Execution timeline</summary>
            {trace}
          </details>
        </>
      )}
      {w.mode === "assist" && trace}
    </>
  );
  return (
    <main
      className={
        "workbench " +
        (!sidebar ? "sidebar-collapsed " : "") +
        (review ? "review-open" : "")
      }
    >
      {sidebar && (
        <aside className="sidebar" aria-label="Project navigation">
          <div className="brand">
            <div className="brand-symbol">
              <Bird size={24} />
            </div>
            <span>
              thrush<span className="brand-period">.</span>
            </span>
            <button
              className="icon-button"
              aria-label="Collapse sidebar"
              onClick={() => setSidebar(false)}
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
          <button
            className="new-task"
            disabled={w.busy}
            onClick={() =>
              project ? void w.newSession() : setAddProject(true)
            }
          >
            <Plus size={17} />
            New task<span>+</span>
          </button>
          <button
            className="environment-badge"
            onClick={() => desktop && setSettings(true)}
            title="Execution environment"
          >
            <span className="status-dot done" />
            <span>{envLabel}</span>
            {desktop && <ChevronDown size={14} />}
          </button>
          <div className="nav-section-title">
            <span>PROJECTS</span>
            <button
              className="icon-button"
              aria-label="Add project"
              disabled={w.busy}
              onClick={() => setAddProject(true)}
            >
              <FolderPlus size={16} />
            </button>
          </div>
          <div className="project-navigation">
            {w.snapshot.projects.map((p) => (
              <section className="project-group" key={p.id}>
                <button
                  className={
                    "project-row " + (project?.id === p.id ? "selected" : "")
                  }
                  disabled={w.busy}
                  onClick={() => w.selectProject(p.id)}
                >
                  <Folder size={16} />
                  <span>{p.name}</span>
                  {project?.id === p.id ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </button>
                {project?.id === p.id && (
                  <div className="task-navigation">
                    {p.sessions.map((s) => (
                      <button
                        key={s.id}
                        className={
                          session?.id === s.id && w.mode === "assist"
                            ? "selected"
                            : ""
                        }
                        disabled={w.busy}
                        onClick={() => w.selectSession(p.id, s.id)}
                      >
                        <MessageSquare size={14} />
                        <span>{s.title}</span>
                      </button>
                    ))}
                    <button
                      disabled={w.busy}
                      onClick={() => {
                        w.setMode("auto");
                        w.setRunId(null);
                      }}
                      className={
                        w.mode === "auto" && !w.runId ? "selected" : ""
                      }
                    >
                      <Plus size={14} />
                      <span>New Auto Run</span>
                    </button>
                    {w.runs.map((r) => (
                      <button
                        key={r.id}
                        disabled={w.busy}
                        className={
                          w.mode === "auto" && w.runId === r.id
                            ? "selected"
                            : ""
                        }
                        onClick={() => {
                          w.setMode("auto");
                          w.setRunId(r.id);
                        }}
                      >
                        <span
                          className={
                            "status-dot " +
                            (isRunning(r.status)
                              ? "running"
                              : r.status === "completed"
                                ? "done"
                                : "idle")
                          }
                        />
                        <span>{r.task}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            ))}
            {!w.snapshot.projects.length && !w.loading && (
              <p className="nav-empty">
                A space for every project.
                <br />
                Add your first one to begin.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="local-note">
              <ShieldCheck size={16} />
              <div>
                <strong>Your code. Your computer.</strong>
                <span>A local agent workspace.</span>
              </div>
            </div>
            {desktop && (
              <button
                className="settings-button"
                onClick={() => setSettings(true)}
              >
                <Settings2 size={17} />
                <span>Settings</span>
                <span className="version">v{desktop.version}</span>
              </button>
            )}
          </div>
        </aside>
      )}
      <section className="main-panel">
        <header className="workspace-header">
          <div className="breadcrumbs">
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="Open sidebar"
                onClick={() => setSidebar(true)}
              >
                <PanelLeftOpen size={18} />
              </button>
            )}
            <span>{project?.name || "Workspace"}</span>
            <ChevronRight size={14} />
            <strong>
              {w.mode === "assist" ? session?.title || "New task" : "Auto Run"}
            </strong>
          </div>
          <button
            className={"icon-button " + (review ? "selected" : "")}
            aria-label="Open review"
            onClick={() => setReview(!review)}
          >
            <PanelRight size={19} />
          </button>
        </header>
        <div className="mode-toolbar">
          <div
            role="tablist"
            aria-label="Workbench mode"
            className="mode-switch"
          >
            <button
              role="tab"
              aria-selected={w.mode === "assist"}
              onClick={() => w.setMode("assist")}
              className={w.mode === "assist" ? "active" : ""}
            >
              <MessageSquare size={14} />
              Assist
            </button>
            <button
              role="tab"
              aria-selected={w.mode === "auto"}
              onClick={() => w.setMode("auto")}
              className={w.mode === "auto" ? "active" : ""}
            >
              <Sparkles size={14} />
              Auto
            </button>
          </div>
          <span
            className="workspace-location"
            title={
              session?.sessionContext.workspacePathOverride ||
              project?.workspacePath
            }
          >
            <GitBranch size={13} />
            {project?.workspacePath || "No project selected"}
            {session?.sessionContext.readOnly ? " · Read only" : ""}
          </span>
        </div>
        {desktop?.phase === "error" && (
          <div role="alert" className="error service-error">
            {desktop.message}
            <button
              className="button"
              onClick={() =>
                void window.thrushDesktop
                  ?.restart()
                  .catch((e) => w.setError(errorText(e)))
              }
            >
              Restart service
            </button>
          </div>
        )}
        {w.error && (
          <div className="error workbench-error" role="alert">
            <span>{w.error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => w.setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div
          className="conversation-scroll"
          ref={viewport}
          onScroll={() => {
            const el = viewport.current;
            if (el)
              setAtBottom(
                el.scrollHeight - el.scrollTop - el.clientHeight < 90,
              );
          }}
        >
          {w.loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={22} />
              Opening your workspace…
            </div>
          ) : !project ? (
            <div className="welcome">
              <div className="welcome-logo">
                <Bird size={40} strokeWidth={1.3} />
              </div>
              <p className="eyebrow">A LITTLE HELP. A LOT OF POSSIBILITY.</p>
              <h1>
                Good work starts
                <br />
                with a little <span>curiosity.</span>
              </h1>
              <p>
                Meet your local coding partner.
                <br />
                Bring a project. We’ll take the next step together.
              </p>
              <button
                className="button primary large"
                onClick={() => setAddProject(true)}
              >
                <FolderPlus size={17} />
                Open your first project
                <ArrowRight size={17} />
              </button>
              <div className="welcome-footnote">
                <ShieldCheck size={14} />
                You stay in control of every change.
              </div>
            </div>
          ) : w.mode === "assist" ? (
            <>
              {!session?.messages.length ? (
                <div className="welcome task-welcome">
                  <div className="welcome-logo">
                    <Bird size={38} strokeWidth={1.3} />
                  </div>
                  <p className="eyebrow">LET’S MAKE SOMETHING GOOD</p>
                  <h1>
                    What are we
                    <br />
                    <span>working on?</span>
                  </h1>
                  <p>Explore an idea, untangle a bug, or build what’s next.</p>
                  <div className="suggestion-grid">
                    {suggestions.map((s) => (
                      <button
                        key={s.title}
                        onClick={() => {
                          setInput(s.task);
                          if (!session) void w.newSession();
                        }}
                      >
                        <s.icon size={19} />
                        <strong>{s.title}</strong>
                        <ArrowUpRight size={15} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="message-list">
                  {session.messages.map((message) => (
                    <article
                      className={"message " + message.role}
                      key={message.id}
                    >
                      {message.role === "assistant" ? (
                        <div className="assistant-avatar">
                          <Bird size={19} />
                        </div>
                      ) : (
                        <div className="user-avatar">Y</div>
                      )}
                      <div className="message-body">
                        <div className="message-label">
                          {message.role === "assistant" ? "Thrush" : "You"}
                        </div>
                        <Markdown text={message.content} />
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {w.busy && (
                <div className="working-indicator" role="status">
                  <LoaderCircle className="spin" size={17} />
                  <span>
                    {session?.steps.find((s) => s.status === "running")
                      ?.title || "Working through your task"}
                  </span>
                  <button className="text-button" onClick={() => openReview()}>
                    View activity
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="auto-workspace">
              {!run ? (
                <>
                  <div className="auto-intro">
                    <div className="welcome-logo">
                      <Sparkles size={28} />
                    </div>
                    <p className="eyebrow">A TASK. TAKEN FURTHER.</p>
                    <h1>
                      Give it a goal.
                      <br />
                      <span>Come back to progress.</span>
                    </h1>
                    <p>
                      Thrush works in an isolated copy of your project,
                      <br />
                      then brings back a report and changes to review.
                    </p>
                  </div>
                </>
              ) : (
                <div className="run-summary">
                  <div className="run-top">
                    <span className={"run-status " + run.status}>
                      <span
                        className={
                          "status-dot " +
                          (isRunning(run.status)
                            ? "running"
                            : run.status === "completed"
                              ? "done"
                              : "idle")
                        }
                      />
                      {run.resultStatus === "imported_history"
                        ? "Imported history"
                        : run.status}
                    </span>
                    <time>{new Date(run.createdAt).toLocaleString()}</time>
                  </div>
                  <h1>{run.task}</h1>
                  <div className="run-stages">
                    {[
                      "queued",
                      "preparing",
                      "running",
                      "reporting",
                      "completed",
                    ].map((s, i) => (
                      <span
                        className={run.status === s ? "current" : ""}
                        key={s}
                      >
                        {s === "completed" ? (
                          <Check size={14} />
                        ) : (
                          <span>{i + 1}</span>
                        )}
                        {s}
                      </span>
                    ))}
                  </div>
                  {run.failureMessage && (
                    <div className="error">{run.failureMessage}</div>
                  )}
                  {report?.contentText ? (
                    <div className="report-preview">
                      <p className="eyebrow">AUTO REPORT</p>
                      <Markdown text={report.contentText} />
                    </div>
                  ) : (
                    <div className="info-note">
                      {isRunning(run.status)
                        ? "The Agent is working. Its report and changes will appear here."
                        : "No report was produced. Check the logs for details."}
                    </div>
                  )}
                  <div className="actions">
                    <button
                      className="button primary"
                      onClick={() => openReview("diff")}
                    >
                      <FileCode2 size={16} />
                      Review changes
                    </button>
                    {isRunning(run.status) && (
                      <button
                        className="button"
                        disabled={w.busy}
                        onClick={() => void w.runAction("cancel")}
                      >
                        <Square size={13} />
                        Stop run
                      </button>
                    )}
                    {run.draftPrUrl ? (
                      <a
                        className="button"
                        href={run.draftPrUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Draft PR
                        <ArrowUpRight size={15} />
                      </a>
                    ) : (
                      <button
                        className="button"
                        disabled={
                          w.busy ||
                          run.status !== "completed" ||
                          !run.worktreePath ||
                          !w.readiness?.checks.find((c) => c.name === "github")
                            ?.ok
                        }
                        title="Requires a completed run, its worktree, and GitHub authentication."
                        onClick={() => void w.runAction("create-draft-pr")}
                      >
                        Create Draft PR
                        <ArrowUpRight size={15} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label="Run timeline"
                      onClick={() => openReview()}
                    >
                      <Activity size={18} />
                    </button>
                  </div>
                </div>
              )}
              <details
                className="readiness"
                open={Boolean(
                  w.readiness?.checks.some((c) => c.required && !c.ok),
                )}
              >
                <summary>
                  <ShieldCheck size={16} />
                  <span>
                    {w.checking
                      ? "Checking your environment…"
                      : w.readiness?.canCreateRun
                        ? "Environment ready"
                        : "Environment needs attention"}
                  </span>
                  <ChevronDown size={15} />
                </summary>
                <div className="readiness-content">
                  {w.readiness?.checks.map((check) => (
                    <div className="readiness-row" key={check.name}>
                      <span
                        className={"status-dot " + (check.ok ? "done" : "idle")}
                      />
                      <strong>{check.name}</strong>
                      <p>{check.message}</p>
                    </div>
                  ))}
                  <button className="text-button" onClick={w.reload}>
                    <RefreshCw size={13} />
                    Check again
                  </button>
                  {desktop && (
                    <button
                      className="text-button"
                      onClick={() => setSettings(true)}
                    >
                      Manage runtime
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              </details>
              {w.runs.length > 0 && !run && (
                <div className="recent-runs">
                  <p className="eyebrow">
                    <History size={13} /> RECENT RUNS
                  </p>
                  {w.runs.slice(0, 4).map((r) => (
                    <button key={r.id} onClick={() => w.setRunId(r.id)}>
                      <span>{r.task}</span>
                      <span>
                        {r.status}
                        <ChevronRight size={14} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {project && (
          <div className="bottom-area">
            {!atBottom && w.mode === "assist" && (
              <button className="jump-bottom" onClick={() => setAtBottom(true)}>
                <ArrowDown size={14} />
                Latest messages
              </button>
            )}
            {pending && w.mode === "assist" && (
              <div className="approval-card">
                <div>
                  <FileCode2 size={18} />
                  <strong>Review before applying</strong>
                </div>
                <code>{pending.path}</code>
                <details>
                  <summary>View proposed file</summary>
                  <pre>{pending.content}</pre>
                </details>
                <div className="actions">
                  <button
                    className="button primary"
                    disabled={w.busy}
                    onClick={() =>
                      void w.send(
                        "APPROVE_WRITE " + pending.id,
                        "Approve changes",
                      )
                    }
                  >
                    <Check size={15} />
                    Approve changes
                  </button>
                  <button
                    className="button"
                    disabled={w.busy}
                    onClick={() =>
                      void w.send("CANCEL_WRITE " + pending.id, "Discard draft")
                    }
                  >
                    Discard draft
                  </button>
                </div>
              </div>
            )}
            {pendingSwitch && w.mode === "assist" && (
              <div className="approval-card">
                <strong>Switch this session’s workspace?</strong>
                <code>
                  {pendingSwitch.workspacePath}
                  {pendingSwitch.readOnly ? " · Read only" : ""}
                </code>
                <div className="actions">
                  <button
                    className="button primary"
                    disabled={w.busy}
                    onClick={() =>
                      void w.send(
                        "CONFIRM_WORKSPACE_SWITCH " + pendingSwitch.id,
                        "Confirm workspace switch",
                      )
                    }
                  >
                    Confirm switch
                  </button>
                  <button
                    className="button"
                    disabled={w.busy}
                    onClick={() =>
                      void w.send(
                        "CANCEL_WORKSPACE_SWITCH " + pendingSwitch.id,
                        "Keep current workspace",
                      )
                    }
                  >
                    Keep current
                  </button>
                </div>
              </div>
            )}
            <Composer
              mode={w.mode}
              value={w.mode === "assist" ? input : autoInput}
              onChange={w.mode === "assist" ? setInput : setAutoInput}
              onSubmit={() => void submit()}
              working={w.busy}
              disabled={
                w.mode === "assist"
                  ? !session
                  : !w.readiness?.canCreateRun || w.checking
              }
            />
          </div>
        )}
        <footer className="status-bar">
          <span>
            <span className="status-dot done" />
            {w.busy
              ? "Working"
              : desktop?.phase === "error"
                ? "Disconnected"
                : "Ready"}
            <span className="status-separator">/</span>
            {envLabel}
          </span>
          <span>
            {desktop?.settings.model || "Your local coding partner"}
            <Terminal size={12} />
          </span>
        </footer>
      </section>
      {review && !expanded && (
        <aside className="review-panel" aria-label="Task review">
          {reviewContent}
        </aside>
      )}
      {expanded && (
        <Dialog title="Task review" wide onClose={() => setExpanded(false)}>
          <div className="expanded-review">{reviewContent}</div>
        </Dialog>
      )}
      {settings && desktop && (
        <DesktopSettingsPanel
          desktop={desktop}
          onImported={w.reload}
          onClose={() => setSettings(false)}
        />
      )}
      {addProject && (
        <Dialog title="Open a project" onClose={() => setAddProject(false)}>
          <form
            className="dialog-body"
            onSubmit={async (e) => {
              e.preventDefault();
              setAdding(true);
              setProjectError("");
              try {
                await w.addProject(projectPath, projectName);
                setAddProject(false);
                setProjectPath("");
                setProjectName("");
              } catch (err) {
                setProjectError(errorText(err));
              } finally {
                setAdding(false);
              }
            }}
          >
            <p className="muted">
              Choose a folder for Thrush to work in. Files stay in their
              original location.
            </p>
            <label>
              Project folder
              <div className="input-action">
                <input
                  required
                  autoFocus
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder={
                    desktop?.settings.environment === "wsl"
                      ? "/home/you/projects/my-project"
                      : "C:\\Projects\\my-project"
                  }
                />
                {desktop && (
                  <button
                    type="button"
                    className="button"
                    onClick={async () => {
                      if (desktop.settings.environment === "wsl") {
                        setDirectoryPicker(true);
                        return;
                      }
                      const selected =
                        await window.thrushDesktop?.selectDirectory();
                      if (selected) setProjectPath(selected);
                    }}
                  >
                    <Folder size={16} />
                    Browse
                  </button>
                )}
              </div>
            </label>
            <label>
              Project name<span className="optional">Optional</span>
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Use the folder name"
              />
            </label>
            <p className="info-note">
              <ShieldCheck size={16} />
              Agent file access is scoped to this folder.
            </p>
            {projectError && (
              <p className="error" role="alert">
                {projectError}
              </p>
            )}
            <button className="button primary" disabled={adding}>
              {adding ? "Opening…" : "Open project"}
              <ArrowRight size={16} />
            </button>
          </form>
          {directoryPicker && (
            <DirectoryPicker
              onSelect={setProjectPath}
              onClose={() => setDirectoryPicker(false)}
            />
          )}
        </Dialog>
      )}
    </main>
  );
}
