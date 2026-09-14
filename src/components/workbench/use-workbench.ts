"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchSnapshot, SessionDetail } from "@/types/workbench";
import type { AutoRun, AutoRunDetail, AutoReadiness } from "@/types/auto";
import type { AgentStreamEvent } from "@/types/agent";
import { errorText, post, request } from "./api";
export function useWorkbench() {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>({
    projects: [],
    activeSessionId: null,
  });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [mode, setMode] = useState<"assist" | "auto">("assist");
  const [runs, setRuns] = useState<AutoRun[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutoRunDetail | null>(null);
  const [readiness, setReadiness] = useState<AutoReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState(false);
  const lock = useRef(false);
  const selected = useRef({ projectId, sessionId, runId });
  selected.current = { projectId, sessionId, runId };
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    request<WorkbenchSnapshot>("/api/projects", { signal: controller.signal })
      .then((next) => {
        setSnapshot(next);
        if (!selected.current.projectId) {
          const project =
            next.projects.find((p) =>
              p.sessions.some((s) => s.id === next.activeSessionId),
            ) || next.projects[0];
          setProjectId(project?.id || null);
          setSessionId(
            next.activeSessionId || project?.sessions[0]?.id || null,
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    setSession(null);
    if (!sessionId) return;
    const controller = new AbortController();
    request<{ session: SessionDetail }>(`/api/sessions/${sessionId}`, {
      signal: controller.signal,
    })
      .then((p) => setSession(p.session))
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [sessionId, refresh]);
  useEffect(() => {
    setRuns([]);
    setRunId(null);
    setDetail(null);
    setReadiness(null);
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setChecking(true);
    request<{ readiness: AutoReadiness }>(
      `/api/auto-runs/readiness?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal },
    )
      .then((p) => setReadiness(p.readiness))
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [projectId, refresh, mode]);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const p = await request<{ runs: AutoRun[] }>(
          `/api/auto-runs?projectId=${projectId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setRuns(p.runs);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, refresh]);
  useEffect(() => {
    setDetail(null);
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<AutoRunDetail>(`/api/auto-runs/${runId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail(data);
        if (
          ["queued", "preparing", "running", "reporting"].includes(
            data.run.status,
          )
        )
          timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, refresh]);
  function selectProject(id: string) {
    if (lock.current) return;
    setError("");
    setProjectId(id);
    setSessionId(
      snapshot.projects.find((p) => p.id === id)?.sessions[0]?.id || null,
    );
  }
  function selectSession(pid: string, sid: string) {
    if (lock.current) return;
    setError("");
    setProjectId(pid);
    setSessionId(sid);
    setMode("assist");
  }
  async function newSession(pid = projectId) {
    if (!pid || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const p = await post<{
        session: SessionDetail;
        snapshot: WorkbenchSnapshot;
      }>(`/api/projects/${pid}/sessions`, { title: "New task" });
      setSnapshot(p.snapshot);
      setProjectId(pid);
      setSessionId(p.session.id);
      setSession(p.session);
      setMode("assist");
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function addProject(workspacePath: string, name: string) {
    const p = await post<{
      snapshot: WorkbenchSnapshot;
      project: { id: string };
    }>("/api/projects", { workspacePath, name, confirmWorkspace: true });
    setSnapshot(p.snapshot);
    setProjectId(p.project.id);
    setSessionId(
      p.snapshot.projects.find((x) => x.id === p.project.id)?.sessions[0]?.id ||
        null,
    );
  }
  async function send(task: string, display = task) {
    if (!session || !task.trim() || lock.current) return false;
    const sid = session.id;
    lock.current = true;
    setBusy(true);
    setError("");
    setSession((s) =>
      s
        ? {
            ...s,
            messages: [
              ...s.messages,
              { id: "local-" + Date.now(), role: "user", content: display },
            ],
            steps: [],
          }
        : s,
    );
    let succeeded = false;
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sid, task, stream: true }),
      });
      if (!response.ok) {
        const p = await response.json();
        throw new Error(p.error || "Task could not start.");
      }
      if (!response.body) throw new Error("The server did not open a stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      function consume(chunk: string) {
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) return;
        const event = JSON.parse(data) as
          | AgentStreamEvent
          | { type: "error"; message: string };
        if (event.type === "error") throw new Error(event.message);
        setSession((s) => {
          if (!s || s.id !== sid) return s;
          if (event.type === "message")
            return { ...s, messages: [...s.messages, event.message] };
          if (event.type === "steps") return { ...s, steps: event.steps };
          if (event.type === "done")
            return { ...s, sessionContext: event.sessionContext };
          return s;
        });
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        for (const part of parts) consume(part);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
      succeeded = true;
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
      reload();
    }
    return succeeded;
  }
  async function startAuto(task: string) {
    if (!projectId || lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const p = await post<{ run: AutoRun }>("/api/auto-runs", {
        projectId,
        task,
      });
      setRunId(p.run.id);
      reload();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function runAction(action: "cancel" | "create-draft-pr") {
    if (!runId || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await post(`/api/auto-runs/${runId}/${action}`, {});
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return {
    snapshot,
    project: snapshot.projects.find((p) => p.id === projectId) || null,
    session,
    mode,
    setMode,
    runs,
    runId,
    setRunId,
    detail,
    readiness,
    checking,
    busy,
    loading,
    error,
    setError,
    reload,
    selectProject,
    selectSession,
    newSession,
    addProject,
    send,
    startAuto,
    runAction,
  };
}
