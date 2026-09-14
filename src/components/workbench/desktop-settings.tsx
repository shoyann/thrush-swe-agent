"use client";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  Monitor,
  RefreshCw,
  Terminal,
} from "lucide-react";
import type { DesktopState, DesktopSettings } from "@/types/desktop";
import { Dialog } from "./dialog";
import { errorText, post, request } from "./api";
type Listing = {
  current: string;
  parent: string;
  directories: { name: string; path: string }[];
};
export function DirectoryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  async function load(path = "") {
    try {
      setListing(
        await request<Listing>(
          "/api/desktop?action=directories&path=" + encodeURIComponent(path),
        ),
      );
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <Dialog title="Choose an Ubuntu directory" onClose={onClose}>
      <div className="dialog-body">
        <p className="muted">Folders in the selected WSL environment</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="folder-location">
          <button
            className="icon-button"
            aria-label="Parent directory"
            onClick={() => void load(listing?.parent)}
          >
            <ArrowLeft size={16} />
          </button>
          <code>{listing?.current || "Loading…"}</code>
        </div>
        <div className="directory-list">
          {listing?.directories.map((d) => (
            <button key={d.path} onClick={() => void load(d.path)}>
              <Folder size={16} />
              <span>{d.name}</span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
        <button
          className="button primary"
          disabled={!listing}
          onClick={() => {
            if (listing) onSelect(listing.current);
            onClose();
          }}
        >
          Select this folder
        </button>
      </div>
    </Dialog>
  );
}
type CheckResult = { ok: boolean; message: string };
type Dependencies = {
  git: CheckResult;
  docker: CheckResult;
  github: CheckResult;
  mini: CheckResult;
  browser: CheckResult;
  setup: { running: boolean; lines: string[]; error: string | null };
};
export function DesktopSettingsPanel({
  desktop,
  onClose,
  onImported,
}: {
  desktop: DesktopState;
  onClose: () => void;
  onImported: () => void;
}) {
  const [tab, setTab] = useState(
    () => sessionStorage.getItem("thrush-setup-step") || "general",
  );
  const [form, setForm] = useState<DesktopSettings>({
    ...desktop.settings,
    apiKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dependencies, setDependencies] = useState<Dependencies | null>(null);
  const [source, setSource] = useState("");
  const [picker, setPicker] = useState(false);
  async function check() {
    try {
      setDependencies(
        await request<Dependencies>("/api/desktop?action=dependencies"),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (tab !== "runtime") return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const p = await request<Dependencies>(
          "/api/desktop?action=dependencies",
        );
        if (!canceled) {
          setDependencies(p);
          timer = setTimeout(poll, p.setup.running ? 1500 : 10000);
        }
      } catch (e) {
        if (!canceled) setError(errorText(e));
      }
    }
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [tab]);
  const onboarding =
    !desktop.settings.configured ||
    Boolean(sessionStorage.getItem("thrush-setup-step"));
  const navigate = (next: string) => {
    setTab(next);
    setError("");
    setNotice("");
  };
  async function browse() {
    if (desktop.settings.environment === "wsl") {
      setPicker(true);
      return;
    }
    const value = await window.thrushDesktop?.selectDirectory();
    if (value) setSource(value);
  }
  return (
    <Dialog
      title={onboarding ? "Set up your workspace" : "Settings"}
      onClose={onClose}
      wide
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {[
            ["general", "Environment & model"],
            ["runtime", "Runtime & tools"],
            ["import", "Import history"],
          ].map(([id, label], index) => (
            <button
              className={tab === id ? "selected" : ""}
              key={id}
              onClick={() => navigate(id)}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {label}
            </button>
          ))}
          <button onClick={() => void window.thrushDesktop?.openLogs()}>
            Diagnostic logs ↗
          </button>
          <p>
            Thrush {desktop.version}
            <br />
            Local to your computer.
          </p>
        </nav>
        <div className="settings-content">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {tab === "general" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  if (onboarding)
                    sessionStorage.setItem("thrush-setup-step", "runtime");
                  await window.thrushDesktop?.configure(form);
                } catch (err) {
                  sessionStorage.removeItem("thrush-setup-step");
                  setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p className="eyebrow">YOUR WORKSPACE</p>
              <h3>Choose where Thrush works.</h3>
              <p className="muted">
                Each environment keeps its own projects and task history.
              </p>
              <div className="environment-options">
                {(["native", "wsl"] as const).map((env) => (
                  <button
                    type="button"
                    key={env}
                    className={form.environment === env ? "selected" : ""}
                    onClick={() =>
                      setForm({
                        ...form,
                        environment: env,
                        distribution:
                          form.distribution || desktop.distributions[0] || "",
                      })
                    }
                  >
                    {env === "native" ? (
                      <Monitor size={20} />
                    ) : (
                      <Terminal size={20} />
                    )}
                    <strong>
                      {env === "native" ? "Windows" : "Ubuntu · WSL"}
                    </strong>
                    <span>
                      {env === "native"
                        ? "Use your local Windows tools"
                        : "Work inside a Linux environment"}
                    </span>
                  </button>
                ))}
              </div>
              {form.environment === "wsl" && (
                <label>
                  Ubuntu distribution
                  <select
                    value={form.distribution}
                    onChange={(e) =>
                      setForm({ ...form, distribution: e.target.value })
                    }
                  >
                    <option value="">Choose a distribution</option>
                    {desktop.distributions.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                  {!desktop.distributions.length && (
                    <span className="muted">
                      No supported Ubuntu installation found.{" "}
                      <a
                        href="https://learn.microsoft.com/windows/wsl/install"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Set up WSL ↗
                      </a>
                    </span>
                  )}
                </label>
              )}
              <div className="section-divider" />
              <h3>Connect your model.</h3>
              <div className="form-grid">
                <label>
                  Provider
                  <select
                    value={form.provider}
                    onChange={(e) => {
                      const provider = e.target
                        .value as DesktopSettings["provider"];
                      setForm({
                        ...form,
                        provider,
                        model:
                          provider === "deepseek"
                            ? "deepseek-v4-flash"
                            : provider === "openai"
                              ? "gpt-4.1-mini"
                              : "claude-sonnet-4-20250514",
                        baseURL: "",
                        apiKey: "",
                      });
                    }}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI-compatible</option>
                    <option value="anthropic">Anthropic gateway</option>
                  </select>
                </label>
                <label>
                  Model
                  <input
                    required
                    value={form.model}
                    onChange={(e) =>
                      setForm({ ...form, model: e.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                API base URL{" "}
                <span className="optional">
                  {form.provider === "anthropic"
                    ? "Required compatible gateway"
                    : "Optional"}
                </span>
                <input
                  type="url"
                  value={form.baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) =>
                    setForm({ ...form, baseURL: e.target.value })
                  }
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  placeholder={
                    desktop.settings.hasKey &&
                    form.provider === desktop.settings.provider
                      ? "Saved securely · leave blank to keep"
                      : "Enter your API key"
                  }
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
                <span className="muted">
                  Encrypted by Windows. Your key stays on this computer.
                </span>
              </label>
              <button
                className="button primary"
                disabled={busy || desktop.active > 0}
              >
                {busy
                  ? "Starting environment…"
                  : onboarding
                    ? "Save & continue"
                    : "Save changes"}
                <ArrowRight size={16} />
              </button>
              {desktop.active > 0 && (
                <p className="muted">
                  Settings can be changed after active tasks finish.
                </p>
              )}
            </form>
          )}
          {tab === "runtime" && (
            <>
              <p className="eyebrow">READY TO WORK</p>
              <h3>Your tools, in one place.</h3>
              <p className="muted">
                Thrush can prepare its own Agent and browser tools. Git and
                Docker are checked separately.
              </p>
              <div className="dependency-list">
                {(["git", "mini", "browser", "docker", "github"] as const).map(
                  (name) => (
                    <div className="dependency" key={name}>
                      <span
                        className={
                          "status-dot " +
                          (dependencies?.[name].ok ? "done" : "idle")
                        }
                      />
                      <div>
                        <strong>
                          {
                            {
                              git: "Git",
                              mini: "Python & Agent",
                              browser: "Browser tools",
                              docker: "Docker · Auto Mode",
                              github: "GitHub CLI · Draft PRs",
                            }[name]
                          }
                        </strong>
                        <p>{dependencies?.[name].message || "Checking…"}</p>
                      </div>
                      {(name === "git" ||
                        name === "docker" ||
                        name === "github" ||
                        name === "browser") &&
                        !dependencies?.[name].ok && (
                          <a
                            href={
                              {
                                git:
                                  desktop.settings.environment === "wsl"
                                    ? "https://git-scm.com/downloads/linux"
                                    : "https://git-scm.com/downloads/win",
                                browser:
                                  "https://playwright.dev/docs/browsers#install-system-dependencies",
                                docker:
                                  "https://docs.docker.com/desktop/setup/install/windows-install/",
                                github: "https://cli.github.com/",
                              }[name]
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            Install ↗
                          </a>
                        )}
                    </div>
                  ),
                )}
              </div>
              <div className="actions">
                <button
                  className="button primary"
                  disabled={
                    busy || dependencies?.setup.running || desktop.active > 0
                  }
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await post("/api/desktop", { action: "prepare" });
                      await check();
                    } catch (e) {
                      setError(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Download size={16} />
                  {dependencies?.setup.running
                    ? "Preparing runtime…"
                    : "Prepare Agent & browser"}
                </button>
                <button className="button" onClick={() => void check()}>
                  <RefreshCw size={15} />
                  Recheck
                </button>
              </div>
              {dependencies?.setup.lines.length ? (
                <pre className="setup-log">
                  {dependencies.setup.lines.join("")}
                </pre>
              ) : null}
              {dependencies?.setup.error && (
                <p className="error">{dependencies.setup.error}</p>
              )}
              {onboarding && (
                <button
                  className="text-button"
                  onClick={() => {
                    sessionStorage.setItem("thrush-setup-step", "import");
                    navigate("import");
                  }}
                >
                  Continue to history import <ArrowRight size={15} />
                </button>
              )}
            </>
          )}
          {tab === "import" && (
            <>
              <p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p>
              <h3>Bring your history with you.</h3>
              <p className="muted">
                Choose an old Thrush data folder containing thrush.db. Import
                works only into an empty environment and creates a backup first.
              </p>
              <label>
                Previous data directory
                <div className="input-action">
                  <input
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder={
                      desktop.settings.environment === "wsl"
                        ? "/home/you/thrush/data"
                        : "C:\\path\\to\\thrush\\data"
                    }
                  />
                  <button
                    type="button"
                    className="button"
                    onClick={() => void browse()}
                  >
                    <FolderOpen size={17} />
                    Browse
                  </button>
                </div>
              </label>
              <div className="info-note">
                Previous Auto Runs are imported as history. Their reports remain
                available; old worktrees and pending approvals are not resumed.
              </div>
              <button
                className="button"
                disabled={!source || busy || desktop.active > 0}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const result = await post<{
                      projects: number;
                      messages: number;
                      warnings: string[];
                      backup: string;
                    }>("/api/desktop", { action: "import", path: source });
                    setNotice(
                      `Imported ${result.projects} projects and ${result.messages} messages. Backup: ${result.backup}` +
                        (result.warnings.length
                          ? "\n" + result.warnings.join("\n")
                          : ""),
                    );
                    onImported();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Importing…" : "Import history"}
              </button>
              {onboarding && (
                <button
                  className="button primary finish-setup"
                  onClick={() => {
                    sessionStorage.removeItem("thrush-setup-step");
                    onClose();
                  }}
                >
                  <Check size={16} />
                  Finish setup
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {picker && (
        <DirectoryPicker
          onSelect={setSource}
          onClose={() => setPicker(false)}
        />
      )}
    </Dialog>
  );
}
