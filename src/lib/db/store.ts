import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";
import type {
  ProjectSummary,
  SessionDetail,
  SessionSummary,
  WorkbenchSnapshot,
} from "@/types/workbench";
import type { ToolRun } from "@/lib/agent/tool-run-types";
import { getDb } from "@/lib/db/connection";
import { getDefaultWorkspaceRoot } from "@/lib/tools/workspace-path";
import { normalizeWorkspacePath } from "@/lib/workspace/validation";

type ProjectRow = {
  created_at: number;
  id: string;
  name: string;
  updated_at: number;
  workspace_path: string;
  workspace_path_confirmed_at: number | null;
};

type SessionRow = {
  context_json: string;
  created_at: number;
  id: string;
  project_id: string;
  steps_json: string;
  title: string;
  updated_at: number;
};

type MessageRow = {
  content: string;
  created_at: number;
  id: string;
  reasoning_content: string | null;
  role: "user" | "assistant";
};

const starterSteps: AgentStep[] = [
  {
    id: "waiting",
    title: "Waiting for a task",
    detail: "The agent is idle until you send a message.",
    status: "idle",
  },
];

function now() {
  return Date.now();
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapSessionSummary(row: SessionRow): SessionSummary {
  return {
    createdAt: row.created_at,
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function mapProjectSummary(row: ProjectRow, sessions: SessionSummary[]): ProjectSummary {
  return {
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    sessions,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path,
    workspacePathConfirmedAt: row.workspace_path_confirmed_at,
  };
}

function listSessionRowsForProject(projectId: string) {
  return getDb()
    .prepare(
      `SELECT id, project_id, title, context_json, steps_json, created_at, updated_at
       FROM sessions
       WHERE project_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(projectId) as SessionRow[];
}

export function createProject(input: {
  confirmWorkspace: boolean;
  name: string;
  workspacePath: string;
}) {
  if (!input.confirmWorkspace) {
    throw new Error("Workspace path must be confirmed before it is saved.");
  }

  const db = getDb();
  const timestamp = now();
  const projectId = createId("proj");
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const name = input.name.trim() || path.basename(workspacePath) || "Untitled project";

  db.prepare(
    `INSERT INTO projects
      (id, name, workspace_path, workspace_path_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(projectId, name, workspacePath, timestamp, timestamp, timestamp);

  createSession(projectId, "New session");

  return getProject(projectId);
}

export function createSession(projectId: string, title = "New session") {
  const db = getDb();
  const project = getProject(projectId);

  if (!project) {
    throw new Error("Project was not found.");
  }

  const timestamp = now();
  const sessionId = createId("sess");
  const context: AgentSessionContext = {
    projectId,
    sessionId,
  };

  db.prepare(
    `INSERT INTO sessions
      (id, project_id, title, context_json, steps_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    projectId,
    title,
    JSON.stringify(context),
    JSON.stringify(starterSteps),
    timestamp,
    timestamp,
  );

  return getSession(sessionId);
}

export function appendMessage(input: {
  content: string;
  reasoningContent?: string | null;
  role: "user" | "assistant";
  sessionId: string;
}) {
  const db = getDb();
  const timestamp = now();
  const id = createId(input.role === "user" ? "user" : "assistant");

  db.prepare(
    `INSERT INTO messages
      (id, session_id, role, content, reasoning_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.role,
    input.content,
    input.reasoningContent ?? null,
    timestamp,
  );

  touchSession(input.sessionId, timestamp);

  return {
    id,
    role: input.role,
    content: input.content,
    ...(input.reasoningContent ? { reasoning_content: input.reasoningContent } : {}),
  } satisfies ChatMessage;
}

export function updateSessionState(
  sessionId: string,
  sessionContext: AgentSessionContext,
  steps: AgentStep[],
) {
  const timestamp = now();
  getDb()
    .prepare(
      `UPDATE sessions
       SET context_json = ?, steps_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      JSON.stringify({
        ...sessionContext,
        sessionId,
      }),
      JSON.stringify(steps),
      timestamp,
      sessionId,
    );
}

function touchSession(sessionId: string, timestamp = now()) {
  getDb()
    .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .run(timestamp, sessionId);
}

export function getProject(projectId: string) {
  const row = getDb()
    .prepare(
      `SELECT id, name, workspace_path, workspace_path_confirmed_at, created_at, updated_at
       FROM projects
       WHERE id = ?`,
    )
    .get(projectId) as ProjectRow | undefined;

  if (!row) {
    return null;
  }

  return mapProjectSummary(row, listSessionRowsForProject(projectId).map(mapSessionSummary));
}

export function getSession(sessionId: string): SessionDetail | null {
  const row = getDb()
    .prepare(
      `SELECT id, project_id, title, context_json, steps_json, created_at, updated_at
       FROM sessions
       WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;

  if (!row) {
    return null;
  }

  const messageRows = getDb()
    .prepare(
      `SELECT id, role, content, reasoning_content, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`,
    )
    .all(sessionId) as MessageRow[];

  const sessionContext = parseJson<AgentSessionContext>(row.context_json, {});

  return {
    ...mapSessionSummary(row),
    messages: messageRows.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.reasoning_content
        ? { reasoning_content: message.reasoning_content }
        : {}),
    })),
    sessionContext: {
      ...sessionContext,
      projectId: row.project_id,
      sessionId: row.id,
    },
    steps: parseJson<AgentStep[]>(row.steps_json, starterSteps),
  };
}

export function getSessionProject(sessionId: string) {
  const session = getSession(sessionId);

  if (!session) {
    return null;
  }

  const project = getProject(session.projectId);

  if (!project) {
    return null;
  }

  return {
    project,
    session,
  };
}

export function listProjects() {
  const projectRows = getDb()
    .prepare(
      `SELECT id, name, workspace_path, workspace_path_confirmed_at, created_at, updated_at
       FROM projects
       ORDER BY updated_at DESC`,
    )
    .all() as ProjectRow[];

  return projectRows.map((project) =>
    mapProjectSummary(
      project,
      listSessionRowsForProject(project.id).map(mapSessionSummary),
    ),
  );
}

export function ensureWorkbench(): WorkbenchSnapshot {
  let projects = listProjects();

  if (projects.length === 0) {
    mkdirSync(getDefaultWorkspaceRoot(), { recursive: true });
    createProject({
      confirmWorkspace: true,
      name: "Demo workspace",
      workspacePath: getDefaultWorkspaceRoot(),
    });
    projects = listProjects();
  }

  const activeSessionId =
    projects.flatMap((project) => project.sessions).sort((left, right) =>
      right.updatedAt - left.updatedAt,
    )[0]?.id ?? null;

  return {
    activeSessionId,
    projects,
  };
}

export function recordToolRun(input: {
  requestId: string;
  sessionId: string;
  toolRun: ToolRun;
}) {
  const finishedAt = now();
  const startedAt = input.toolRun.startedAt ?? finishedAt;

  getDb()
    .prepare(
      `INSERT INTO tool_runs
        (id, session_id, request_id, tool_call_id, tool_name, input_json,
         input_text, ok, result_content, draft_json, started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId("tool"),
      input.sessionId,
      input.requestId,
      input.toolRun.toolCallId,
      input.toolRun.name,
      JSON.stringify(input.toolRun.input),
      input.toolRun.inputText,
      input.toolRun.result.ok ? 1 : 0,
      input.toolRun.result.content,
      input.toolRun.result.draft
        ? JSON.stringify(input.toolRun.result.draft)
        : null,
      startedAt,
      input.toolRun.finishedAt ?? finishedAt,
      input.toolRun.durationMs ?? Math.max(finishedAt - startedAt, 0),
    );
}

export function createCheckpoint(input: {
  data: unknown;
  kind: string;
  label?: string | null;
  requestId: string;
  sessionId: string;
}) {
  getDb()
    .prepare(
      `INSERT INTO checkpoints
        (id, session_id, request_id, kind, label, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createId("chk"),
      input.sessionId,
      input.requestId,
      input.kind,
      input.label ?? null,
      JSON.stringify(input.data),
      now(),
    );
}

export function listToolRuns(sessionId: string) {
  return getDb()
    .prepare(
      `SELECT id, session_id, request_id, tool_call_id, tool_name, input_text,
        ok, result_content, started_at, finished_at, duration_ms
       FROM tool_runs
       WHERE session_id = ?
       ORDER BY finished_at DESC`,
    )
    .all(sessionId);
}
