import { randomUUID } from "node:crypto";
import type {
  AutoArtifact,
  AutoArtifactType,
  AutoEvent,
  AutoFailureCategory,
  AutoRun,
  AutoRunDetail,
  AutoRunStatus,
  MiniPreset,
  MiniPresetConfig,
} from "@/types/auto";
import { getDb } from "@/lib/db/connection";
import { getProject } from "@/lib/db/store";
import { createRecommendedMiniPresetSnapshot } from "@/lib/auto/recommended-environment";

type AutoRunRow = {
  attempt_group_id: string | null;
  base_commit_sha: string | null;
  branch_name: string | null;
  cancel_requested: number;
  created_at: number;
  diff_artifact_id: string | null;
  draft_pr_url: string | null;
  exit_code: number | null;
  failure_category: AutoFailureCategory | null;
  failure_message: string | null;
  finished_at: number | null;
  head_commit_sha: string | null;
  id: string;
  preset_id: string | null;
  preset_snapshot_json: string;
  project_id: string;
  report_artifact_id: string | null;
  result_status: string | null;
  source_run_id: string | null;
  source_session_id: string | null;
  started_at: number | null;
  status: AutoRunStatus;
  task: string;
  updated_at: number;
  workspace_path: string;
  worktree_path: string | null;
};

type AutoEventRow = {
  auto_run_id: string;
  created_at: number;
  data_json: string;
  id: string;
  message: string;
  type: string;
};

type AutoArtifactRow = {
  auto_run_id: string;
  content_text: string | null;
  created_at: number;
  file_path: string | null;
  id: string;
  label: string;
  metadata_json: string;
  type: AutoArtifactType;
};

type MiniPresetRow = {
  config_json: string;
  created_at: number;
  description: string | null;
  id: string;
  is_default: number;
  name: string;
  project_id: string | null;
  updated_at: number;
};

const activeStatuses: AutoRunStatus[] = [
  "queued",
  "preparing",
  "running",
  "reporting",
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

function mapAutoRun(row: AutoRunRow): AutoRun {
  return {
    attemptGroupId: row.attempt_group_id,
    baseCommitSha: row.base_commit_sha,
    branchName: row.branch_name,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    diffArtifactId: row.diff_artifact_id,
    draftPrUrl: row.draft_pr_url,
    exitCode: row.exit_code,
    failureCategory: row.failure_category,
    failureMessage: row.failure_message,
    finishedAt: row.finished_at,
    headCommitSha: row.head_commit_sha,
    id: row.id,
    presetId: row.preset_id,
    presetSnapshot: parseJson<MiniPresetConfig>(row.preset_snapshot_json, {}),
    projectId: row.project_id,
    reportArtifactId: row.report_artifact_id,
    resultStatus: row.result_status,
    sourceRunId: row.source_run_id,
    sourceSessionId: row.source_session_id,
    startedAt: row.started_at,
    status: row.status,
    task: row.task,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path,
    worktreePath: row.worktree_path,
  };
}

function mapAutoEvent(row: AutoEventRow): AutoEvent {
  return {
    autoRunId: row.auto_run_id,
    createdAt: row.created_at,
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    id: row.id,
    message: row.message,
    type: row.type,
  };
}

function mapAutoArtifact(row: AutoArtifactRow): AutoArtifact {
  return {
    autoRunId: row.auto_run_id,
    contentText: row.content_text,
    createdAt: row.created_at,
    filePath: row.file_path,
    id: row.id,
    label: row.label,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    type: row.type,
  };
}

function mapMiniPreset(row: MiniPresetRow): MiniPreset {
  return {
    config: parseJson<MiniPresetConfig>(row.config_json, {}),
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    isDefault: row.is_default === 1,
    name: row.name,
    projectId: row.project_id,
    updatedAt: row.updated_at,
  };
}

function selectAutoRunById(autoRunId: string) {
  return getDb()
    .prepare("SELECT * FROM auto_runs WHERE id = ?")
    .get(autoRunId) as AutoRunRow | undefined;
}

export function getMiniPreset(presetId: string) {
  const row = getDb()
    .prepare("SELECT * FROM mini_presets WHERE id = ?")
    .get(presetId) as MiniPresetRow | undefined;

  return row ? mapMiniPreset(row) : null;
}

export function createMiniPreset(input: {
  config: MiniPresetConfig;
  description?: string | null;
  isDefault?: boolean;
  name: string;
  projectId?: string | null;
}) {
  const timestamp = now();
  const id = createId("preset");

  getDb()
    .prepare(
      `INSERT INTO mini_presets
        (id, project_id, name, description, is_default, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.projectId ?? null,
      input.name.trim() || "Mini Preset",
      input.description ?? null,
      input.isDefault === true ? 1 : 0,
      JSON.stringify(input.config),
      timestamp,
      timestamp,
    );

  return getMiniPreset(id);
}

export function listMiniPresets(projectId?: string | null) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM mini_presets
       WHERE project_id IS NULL OR project_id = ?
       ORDER BY is_default DESC, updated_at DESC`,
    )
    .all(projectId ?? null) as MiniPresetRow[];

  return rows.map(mapMiniPreset);
}

export function listAutoRuns(projectId: string) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM auto_runs
       WHERE project_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(projectId) as AutoRunRow[];

  return rows.map(mapAutoRun);
}

export function getAutoRun(autoRunId: string) {
  const row = selectAutoRunById(autoRunId);
  return row ? mapAutoRun(row) : null;
}

export function getAutoRunDetail(autoRunId: string): AutoRunDetail | null {
  const run = getAutoRun(autoRunId);

  if (!run) {
    return null;
  }

  return {
    artifacts: listAutoArtifacts(autoRunId),
    events: listAutoEvents(autoRunId),
    run,
  };
}

export function getActiveAutoRunForProject(projectId: string) {
  const placeholders = activeStatuses.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT * FROM auto_runs
       WHERE project_id = ? AND status IN (${placeholders})
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(projectId, ...activeStatuses) as AutoRunRow | undefined;

  return row ? mapAutoRun(row) : null;
}

export function createAutoRun(input: {
  presetId?: string | null;
  sourceRunId?: string | null;
  sourceSessionId?: string | null;
  projectId: string;
  task: string;
}) {
  const project = getProject(input.projectId);

  if (!project) {
    throw new Error("Project was not found.");
  }

  const activeRun = getActiveAutoRunForProject(project.id);
  if (activeRun) {
    throw new Error(
      "This project already has an Auto Run in progress. Wait for it to finish or cancel it before starting another one.",
    );
  }

  const preset = input.presetId ? getMiniPreset(input.presetId) : null;
  if (input.presetId && !preset) {
    throw new Error("Mini Preset was not found.");
  }

  const timestamp = now();
  const id = createId("auto");
  const presetSnapshot =
    preset?.config ?? createRecommendedMiniPresetSnapshot(project.workspacePath);

  getDb()
    .prepare(
      `INSERT INTO auto_runs
        (id, project_id, source_session_id, source_run_id, attempt_group_id,
         preset_id, preset_snapshot_json, task, status, workspace_path,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      project.id,
      input.sourceSessionId ?? null,
      input.sourceRunId ?? null,
      null,
      preset?.id ?? null,
      JSON.stringify(presetSnapshot),
      input.task.trim(),
      "queued",
      project.workspacePath,
      timestamp,
      timestamp,
    );

  appendAutoEvent({
    autoRunId: id,
    message:
      "Auto Run queued. Thrush will work in an isolated copy of your project.",
    type: "queued",
  });

  return getAutoRun(id);
}

export function claimNextQueuedAutoRun() {
  const timestamp = now();
  const db = getDb();
  const claim = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM auto_runs
         WHERE status = 'queued' AND cancel_requested = 0
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as AutoRunRow | undefined;

    if (!row) {
      return null;
    }

    db.prepare(
      `UPDATE auto_runs
       SET status = 'preparing', started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    ).run(timestamp, timestamp, row.id);

    return getAutoRun(row.id);
  });

  return claim();
}

export function markAutoRunStatus(input: {
  autoRunId: string;
  status: AutoRunStatus;
  failureCategory?: AutoFailureCategory | null;
  failureMessage?: string | null;
  resultStatus?: string | null;
}) {
  const timestamp = now();
  const isFinal =
    input.status === "completed" ||
    input.status === "failed" ||
    input.status === "canceled";

  getDb()
    .prepare(
      `UPDATE auto_runs
       SET status = ?, result_status = COALESCE(?, result_status),
           failure_category = ?, failure_message = ?,
           finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status,
      input.resultStatus ?? null,
      input.failureCategory ?? null,
      input.failureMessage ?? null,
      isFinal ? 1 : 0,
      timestamp,
      timestamp,
      input.autoRunId,
    );
}

export function updateAutoRunPaths(input: {
  autoRunId: string;
  baseCommitSha?: string | null;
  branchName?: string | null;
  headCommitSha?: string | null;
  worktreePath?: string | null;
}) {
  getDb()
    .prepare(
      `UPDATE auto_runs
       SET worktree_path = COALESCE(?, worktree_path),
           branch_name = COALESCE(?, branch_name),
           base_commit_sha = COALESCE(?, base_commit_sha),
           head_commit_sha = COALESCE(?, head_commit_sha),
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.worktreePath ?? null,
      input.branchName ?? null,
      input.baseCommitSha ?? null,
      input.headCommitSha ?? null,
      now(),
      input.autoRunId,
    );
}

export function finishAutoRun(input: {
  autoRunId: string;
  diffArtifactId?: string | null;
  draftPrUrl?: string | null;
  exitCode?: number | null;
  headCommitSha?: string | null;
  reportArtifactId?: string | null;
  resultStatus?: string | null;
  status: AutoRunStatus;
}) {
  const timestamp = now();
  getDb()
    .prepare(
      `UPDATE auto_runs
       SET status = ?, result_status = ?, exit_code = ?,
           head_commit_sha = COALESCE(?, head_commit_sha),
           report_artifact_id = COALESCE(?, report_artifact_id),
           diff_artifact_id = COALESCE(?, diff_artifact_id),
           draft_pr_url = COALESCE(?, draft_pr_url),
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.status,
      input.resultStatus ?? null,
      input.exitCode ?? null,
      input.headCommitSha ?? null,
      input.reportArtifactId ?? null,
      input.diffArtifactId ?? null,
      input.draftPrUrl ?? null,
      timestamp,
      timestamp,
      input.autoRunId,
    );
}

export function requestAutoRunCancel(autoRunId: string, reason?: string) {
  getDb()
    .prepare(
      `UPDATE auto_runs
       SET cancel_requested = 1, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'preparing', 'running', 'reporting')`,
    )
    .run(now(), autoRunId);

  appendAutoEvent({
    autoRunId,
    data: { reason: reason ?? null },
    message: "Cancellation requested.",
    type: "cancel_requested",
  });

  return getAutoRun(autoRunId);
}

export function appendAutoEvent(input: {
  autoRunId: string;
  data?: Record<string, unknown>;
  message: string;
  type: string;
}) {
  const id = createId("evt");
  getDb()
    .prepare(
      `INSERT INTO auto_events
        (id, auto_run_id, type, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.autoRunId,
      input.type,
      input.message,
      JSON.stringify(input.data ?? {}),
      now(),
    );

  return id;
}

export function listAutoEvents(autoRunId: string) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM auto_events
       WHERE auto_run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(autoRunId) as AutoEventRow[];

  return rows.map(mapAutoEvent);
}

export function createAutoArtifact(input: {
  autoRunId: string;
  contentText?: string | null;
  filePath?: string | null;
  label: string;
  metadata?: Record<string, unknown>;
  type: AutoArtifactType;
}) {
  const id = createId("art");
  getDb()
    .prepare(
      `INSERT INTO auto_artifacts
        (id, auto_run_id, type, label, content_text, file_path, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.autoRunId,
      input.type,
      input.label,
      input.contentText ?? null,
      input.filePath ?? null,
      JSON.stringify(input.metadata ?? {}),
      now(),
    );

  return id;
}

export function listAutoArtifacts(autoRunId: string) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM auto_artifacts
       WHERE auto_run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(autoRunId) as AutoArtifactRow[];

  return rows.map(mapAutoArtifact);
}

export function recordDraftPrUrl(autoRunId: string, url: string) {
  const artifactId = createAutoArtifact({
    autoRunId,
    contentText: url,
    label: "GitHub Draft PR",
    type: "draft_pr",
  });

  getDb()
    .prepare(
      `UPDATE auto_runs
       SET draft_pr_url = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(url, now(), autoRunId);

  return artifactId;
}
