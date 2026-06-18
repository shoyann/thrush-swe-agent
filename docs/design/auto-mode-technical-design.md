# Auto Mode Technical Design

## Overview

Auto Mode adds project-scoped Auto Runs to Thrush. Each Auto Run uses bundled mini-swe-agent to attempt a clear coding task inside an isolated Git worktree, defaults to mini-swe-agent's Docker environment, and produces reviewable artifacts before any change is applied to the main workspace or pushed to GitHub.

Assist Mode remains the existing session-scoped, semi-automatic workflow. Auto Mode is a separate project-scoped worker workflow, not a flag inside `/api/agent`.

## Data Model

### `auto_runs`

`auto_runs` is the task record for an autonomous attempt.

Recommended columns:

- `id TEXT PRIMARY KEY`
- `project_id TEXT NOT NULL`
- `source_session_id TEXT`
- `source_run_id TEXT`
- `attempt_group_id TEXT`
- `preset_id TEXT`
- `preset_snapshot_json TEXT NOT NULL`
- `task TEXT NOT NULL`
- `status TEXT NOT NULL`
- `result_status TEXT`
- `workspace_path TEXT NOT NULL`
- `worktree_path TEXT`
- `branch_name TEXT`
- `base_commit_sha TEXT`
- `head_commit_sha TEXT`
- `exit_code INTEGER`
- `failure_category TEXT`
- `failure_message TEXT`
- `report_artifact_id TEXT`
- `diff_artifact_id TEXT`
- `draft_pr_url TEXT`
- `started_at INTEGER`
- `finished_at INTEGER`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Notes:

- `preset_snapshot_json` is required so historical runs remain understandable even when the run used the recommended environment or after the user edits a Mini Preset.
- `source_session_id` links an Auto Run back to Assist when it was launched from that context, but Auto Runs do not become chat messages.
- `source_run_id` supports follow-up Auto Runs.
- `attempt_group_id` leaves room for future multiple-attempt Auto Runs.
- `status` uses the product states: `queued`, `preparing`, `running`, `reporting`, `completed`, `failed`, `canceled`.
- `result_status` mirrors the mini-swe-agent outcome when available.

### `auto_events`

`auto_events` is the timeline for a run.

Recommended columns:

- `id TEXT PRIMARY KEY`
- `auto_run_id TEXT NOT NULL`
- `type TEXT NOT NULL`
- `message TEXT NOT NULL`
- `data_json TEXT NOT NULL DEFAULT '{}'`
- `created_at INTEGER NOT NULL`

Events should be append-only. They power the progress UI and are also useful for debugging failed runs.

### `auto_artifacts`

`auto_artifacts` stores or points to generated run evidence.

Recommended columns:

- `id TEXT PRIMARY KEY`
- `auto_run_id TEXT NOT NULL`
- `type TEXT NOT NULL`
- `label TEXT NOT NULL`
- `content_text TEXT`
- `file_path TEXT`
- `metadata_json TEXT NOT NULL DEFAULT '{}'`
- `created_at INTEGER NOT NULL`

Initial artifact types:

- `report`
- `diff`
- `diff_stat`
- `changed_files`
- `logs`
- `trajectory`
- `test_output`
- `patch`
- `draft_pr`

Large artifacts should be stored as files under the run artifact directory and referenced by `file_path`.

### `mini_presets`

`mini_presets` stores saved execution choices for Auto Runs.

Recommended columns:

- `id TEXT PRIMARY KEY`
- `project_id TEXT`
- `name TEXT NOT NULL`
- `description TEXT`
- `is_default INTEGER NOT NULL DEFAULT 0`
- `config_json TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Preset scope:

- `project_id IS NULL` means global preset.
- `project_id NOT NULL` means project-specific preset.

The default preset should reuse Thrush's current model/API configuration unless the user overrides it.

## API Design

### `POST /api/auto-runs`

Creates an Auto Run.

Input:

- `projectId`
- `task`
- `presetId` optional
- `sourceSessionId` optional
- `sourceRunId` optional

Behavior:

- Validate project and workspace.
- Reject if another Auto Run is active for the same project in the first version.
- Reject if the main workspace has uncommitted changes in the first version.
- Resolve the recommended environment or selected Mini Preset.
- Snapshot the resolved execution config into `preset_snapshot_json`.
- Create the run as `queued`.
- Start the runner asynchronously.

### `GET /api/auto-runs`

Lists Auto Runs, filtered by project.

### `GET /api/auto-runs/:id`

Returns the Auto Run, events, and artifacts metadata.

### `GET /api/auto-runs/readiness`

Returns the environment readiness for a project.

Input:

- `projectId`
- `presetId` optional

Behavior:

- Resolve the recommended environment or selected preset.
- Check Git workspace cleanliness, Docker availability, mini-swe-agent availability, model configuration, and GitHub Draft PR readiness.
- Return structured checks with `ok`, `required`, `category`, and plain-language `message`.
- `canCreateRun` is false when any required check fails.

### `POST /api/auto-runs/:id/cancel`

Cancels a queued, preparing, or running Auto Run.

Behavior:

- Mark cancel requested.
- Stop the mini-swe-agent child process if running.
- Clean up the Docker container when possible.
- Append a cancellation event.
- Produce a canceled Auto Report.

### `POST /api/auto-runs/:id/create-draft-pr`

Creates a GitHub Draft PR after the run has completed and the user has reviewed the result.

Behavior:

- Check GitHub CLI availability and authentication.
- Check remote readiness.
- Push the Auto Run branch.
- Create a Draft PR.
- Store the PR URL as both `draft_pr_url` and a `draft_pr` artifact.

## UI Structure

The main project workspace uses top-level `Assist | Auto` tabs.

- `Assist` shows the existing session-scoped chat workflow.
- `Auto` shows Auto Run creation, run history, progress, Auto Reports, artifacts, and Draft PR actions.

The left sidebar remains focused on project selection. Auto Runs should not be mixed into the session list as peer chat sessions.

## Runner Flow

Auto Runs are executed by a local Auto Worker. The Next.js API creates and reads run records, while the worker claims queued runs, manages mini-swe-agent processes, writes events and artifacts, and handles cancellation.

1. Load the Auto Run and preset snapshot.
2. Mark status `preparing`.
3. Create an isolated Git worktree.
4. Create an Auto Run branch such as `auto/<autoRunId>`.
5. Generate the mini-swe-agent config for this run.
6. Mark status `running`.
7. Spawn mini-swe-agent through Thrush's non-interactive wrapper as an external process.
8. Stream stdout/stderr into events and log artifacts.
9. On completion, parse the trajectory `info.exit_status`, then collect exit code, changed files, diff stat, and diff.
10. Mark status `reporting`.
11. Generate the Auto Report with Thrush's model client.
12. If model reporting fails, generate a fallback report from structured artifacts.
13. Mark status `completed`, `failed`, or `canceled`.

## Bundled mini-swe-agent

Thrush should prefer a bundled mini-swe-agent checkout, such as `vendor/mini-swe-agent`, instead of requiring users to install mini manually before trying Auto Mode.

Recommended resolution order:

1. Bundled venv Python running `scripts/mini-auto-run.py`
2. Bundled `vendor/mini-swe-agent` source through `PYTHONPATH` plus `uv run --no-project --with <runtime deps>`
3. Advanced override via environment variables
4. `uvx mini-swe-agent`
5. Human-readable setup error

The bundled copy should be managed as a Git submodule or clearly tracked vendored dependency so version updates remain auditable.

Thrush should prefer the non-interactive wrapper instead of mini-swe-agent's interactive CLI. This avoids background process failures from prompt UI libraries and gives Thrush a stable trajectory file to inspect. The wrapper must not call mini-swe-agent's first-run configuration wizard; Thrush passes the selected model and model API keys through the run config and process environment.

The bundled source fallback should avoid installing mini-swe-agent's full default dependency tree when possible. mini-swe-agent currently includes benchmark-oriented dependencies such as `datasets`, which can pull large wheels such as `pyarrow`. Thrush's normal Auto path only needs the runtime dependencies required by the agent, model, config, and environment layers, so the fallback should use explicit `--with` runtime dependencies and `PYTHONPATH=vendor/mini-swe-agent/src`. A transient dependency download timeout should be classified as `dependency_install_failed`, not as the coding agent failing the task.

## Windows and Docker Strategy

The first implementation targets Windows.

Key requirements:

- Use Windows-safe child process spawning from Node.
- Normalize project workspace paths.
- Convert paths for WSL only when the app is running in WSL.
- Use Docker Desktop-compatible mount paths.
- Keep Auto Run worktrees and artifacts in a predictable project-local or app-data directory.
- Avoid shell-specific command construction where possible.

Auto Run files are stored in Thrush-managed directories:

- `data/auto-runs/<autoRunId>/worktree`
- `data/auto-runs/<autoRunId>/artifacts`

The worktree is a temporary managed copy for the run. Artifacts live next to it so reports, logs, trajectories, and patches can be retained without writing `.thrush` metadata into the user's project.

## Execution Configuration Strategy

The primary Auto Run flow uses a recommended environment. Users should not need to choose Docker images, mount paths, YAML files, or mini-swe-agent config to start a run.

The recommended environment reuses Thrush's current API/model configuration and translates it into mini-swe-agent config. Thrush should infer a practical Docker image from project files when possible, while keeping the choice hidden from the default UI.

When Thrush runs in WSL, Docker readiness must check Docker inside the same WSL runtime. A Windows Docker install is not enough unless Docker Desktop WSL integration exposes the `docker` CLI and daemon to Ubuntu.

Secrets are read from the process environment and passed only to the spawned mini-swe-agent process. Auto should not write API keys into the repository, run artifacts, reports, or chat messages.

Mini Presets are advanced saved execution choices. Users can create custom Mini Presets for:

- Model name
- Model provider/API key behavior
- Cost limit
- Step limit
- Wall-time limit
- Docker image
- Docker network policy
- Environment variables
- Advanced config overrides

The UI should hide Mini Presets behind advanced settings. Presets should be presented as simple saved choices, not raw YAML first.

## Reporting Strategy

Auto Reports belong to Auto Runs, not chat messages.

The generated report should include:

- Result
- What changed
- Why it changed
- How it was verified
- What needs review
- Risks or unfinished work
- Artifacts

The report is a summary. The source of truth remains the diff, logs, trajectory, and test output artifacts.

## Conflict and GitHub Strategy

Auto Runs do not directly modify the main workspace. Applying a patch or creating a Draft PR happens only after review.

The first version should block Auto Runs when the main workspace has uncommitted changes. Future versions can add safer conflict handling and patch application.

Creating a Draft PR is user-triggered. It is not part of mini-swe-agent's autonomous run.

## Failure Modes

Failures should be categorized so the UI can explain them in plain language:

- `workspace_dirty`
- `docker_unavailable`
- `docker_start_failed`
- `dependency_install_failed`
- `mini_unavailable`
- `model_config_missing`
- `mini_failed`
- `timeout`
- `cost_limit`
- `repeated_format_error`
- `canceled`
- `report_failed`
- `github_unavailable`
- `github_auth_missing`
- `github_push_failed`
- `github_pr_failed`
- `unknown`

Each failure should include a specific reason and practical next step.

## First Version Limits

- One active Auto Run per project.
- Docker is the default execution environment.
- Local execution is explicit opt-in.
- No automatic main workspace modification.
- No automatic GitHub PR creation.
- Windows is the first target platform.
