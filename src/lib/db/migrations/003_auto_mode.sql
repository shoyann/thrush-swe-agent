CREATE TABLE IF NOT EXISTS mini_presets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_session_id TEXT,
  source_run_id TEXT,
  attempt_group_id TEXT,
  preset_id TEXT,
  preset_snapshot_json TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'running', 'reporting', 'completed', 'failed', 'canceled')),
  result_status TEXT,
  workspace_path TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  base_commit_sha TEXT,
  head_commit_sha TEXT,
  exit_code INTEGER,
  failure_category TEXT,
  failure_message TEXT,
  report_artifact_id TEXT,
  diff_artifact_id TEXT,
  draft_pr_url TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (source_run_id) REFERENCES auto_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (preset_id) REFERENCES mini_presets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS auto_events (
  id TEXT PRIMARY KEY,
  auto_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (auto_run_id) REFERENCES auto_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_artifacts (
  id TEXT PRIMARY KEY,
  auto_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  content_text TEXT,
  file_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (auto_run_id) REFERENCES auto_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mini_presets_project_default
  ON mini_presets(project_id, is_default);
CREATE INDEX IF NOT EXISTS idx_auto_runs_project_updated
  ON auto_runs(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_auto_runs_project_status
  ON auto_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_auto_events_run_created
  ON auto_events(auto_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auto_artifacts_run_created
  ON auto_artifacts(auto_run_id, created_at);
