<p align="center">
  <img src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" width="120" />
</p>

<h1 align="center">THRUSH V2.0</h1>

<p align="center">
  <strong>A dual-mode local SWE agent workbench.</strong><br>
  Assist when you want to approve every edit. Auto when you want an isolated agent run,
  a readable report, and a reviewable diff.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-15-000000?style=for-the-badge&logo=nextdotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/SQLite-local_state-003B57?style=for-the-badge&logo=sqlite&logoColor=white" />
  <img src="https://img.shields.io/badge/mini--swe--agent-bundled-FFB000?style=for-the-badge" />
</p>

---

## What is Thrush?

Thrush is a local workbench for software engineering agents.

V2.0 has two modes inside the same project UI:

| Mode | Best for | Safety model |
|---|---|---|
| Assist | Working with the agent step by step | The agent drafts edits first; the user approves before files are written |
| Auto | Letting mini-swe-agent attempt a complete task | The agent runs in an isolated Git worktree and returns a report, diff, logs, and trajectory |

Auto does not directly modify your main workspace. It creates a separate worktree under `data/auto-runs/<autoRunId>/worktree`, runs `mini-swe-agent`, then shows what changed. Creating a Draft PR is a user action, not an automatic side effect.

## What changed in V2.0

- Project workbench UI with top-level `Assist | Auto` switching.
- Auto Mode backed by bundled `mini-swe-agent` in `vendor/mini-swe-agent`.
- Non-interactive mini runner at `scripts/mini-auto-run.py`.
- Environment Doctor before Auto starts: Git clean state, Docker, mini runtime, model config, and GitHub readiness.
- Human-readable Auto Report artifact, plus Diff, Logs, Trajectory, and Changed Files in a side drawer.
- Auto runs stored separately from Assist sessions in SQLite tables for runs, events, artifacts, and presets.
- Runtime bootstrap now prepares `data/mini-venv` once so Auto does not block every run on `uv run --with openai/litellm` dependency downloads.

## Quickstart

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/shoyann/thrush-swe-agent.git
cd thrush-swe-agent
```

If you already cloned the repo:

```bash
git submodule update --init --recursive
```

Install Node dependencies:

```bash
npm install
```

Prepare the bundled Auto runtime:

```bash
npm run bootstrap:mini
```

This creates `data/mini-venv`, installs the bundled `mini-swe-agent`, installs the Python runtime dependencies, and writes `data/mini-venv/.ready.json`. The venv and package caches are local generated files and are not committed.

Copy and edit local environment settings:

```bash
cp .env.local.example .env.local
```

At minimum:

```bash
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-api-key
AGENT_API_SECRET=replace-with-a-long-random-local-secret
NEXT_PUBLIC_AGENT_API_SECRET=replace-with-the-same-local-secret
```

Start Thrush:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Windows and WSL

Thrush works best from WSL Ubuntu when your projects live under `/home/<user>/...`.

For Auto Mode with Docker Desktop:

1. Install Docker Desktop on Windows.
2. Open Docker Desktop settings.
3. Go to `Resources -> WSL Integration`.
4. Enable integration for Ubuntu.
5. In WSL, verify:

```bash
docker info
```

If Docker is not visible from WSL, Auto will stop before starting and explain the exact next step.

## Auto Mode

Auto Mode is designed for “try this task end to end, but do not touch my main project.”

Before a run starts, Thrush checks:

- The main Git workspace is clean.
- Docker is available when using the recommended Docker environment.
- The bundled mini runtime is ready.
- The selected model has the required API key.
- GitHub Draft PR creation is available, if you want to create a PR later.

When Auto runs, Thrush:

1. Creates a branch named `auto/<autoRunId>`.
2. Creates an isolated Git worktree under `data/auto-runs`.
3. Starts `mini-swe-agent` through the prepared local venv.
4. Collects diff, diff stat, changed files, logs, and trajectory.
5. Generates a human-readable report.
6. Leaves your main workspace unchanged.

Auto status values:

```text
queued -> preparing -> running -> reporting -> completed
```

Failure states include clear categories such as Docker unavailable, model key missing, mini runtime missing, timeout, cost limit, canceled, or workspace dirty.

## Assist Mode

Assist Mode is the original Thrush workflow.

The agent can inspect files, search code, read pages, reason through issues, run allowlisted commands, and prepare file edits. File writes are not applied immediately. They are staged as pending drafts and require explicit approval.

The core loop is:

```text
Inspect -> Think -> Draft -> Ask -> Write
```

## Environment variables

| Name | Required | Purpose |
|---|---:|---|
| `MODEL_PROVIDER` | No | `deepseek`, `openai`, or `anthropic`; defaults to `deepseek` |
| `DEEPSEEK_API_KEY` | If using DeepSeek | Server-side model key |
| `DEEPSEEK_BASE_URL` | No | Defaults to `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | No | Defaults to `deepseek-v4-flash` |
| `OPENAI_API_KEY` | If using OpenAI | Server-side model key |
| `OPENAI_BASE_URL` | No | Optional OpenAI-compatible base URL |
| `OPENAI_MODEL` | If using OpenAI | Defaults to `gpt-4.1-mini` |
| `ANTHROPIC_API_KEY` | If using Anthropic | Server-side model key |
| `ANTHROPIC_BASE_URL` | If using Anthropic | OpenAI-compatible Anthropic gateway URL |
| `ANTHROPIC_MODEL` | If using Anthropic | Defaults to `claude-sonnet-4-20250514` |
| `AGENT_API_SECRET` | Yes | Server-side Bearer token for `/api/agent` |
| `NEXT_PUBLIC_AGENT_API_SECRET` | Local dev only | Browser token for local UI calls |
| `AGENT_WORKSPACE_ROOT` | No | Default local workspace path |
| `AUTO_RUN_MINI_COMMAND` | Advanced | Override mini runner command |
| `AUTO_RUN_MINI_ARGS_PREFIX_JSON` | Advanced | JSON array of args to prepend to the custom mini command |
| `GH_PATH` | No | Absolute path to `gh.exe` or `gh` if not on `PATH` |

## Local state

Thrush stores local state under `data/`:

| Path | Purpose |
|---|---|
| `data/thrush.db` | SQLite app database |
| `data/workspace` | Default sample workspace |
| `data/auto-runs` | Auto worktrees and artifacts |
| `data/mini-venv` | Generated Python runtime for bundled mini-swe-agent |
| `data/pip-cache`, `data/uv-cache` | Local dependency caches |

These generated files are ignored by Git.

## GitHub Draft PRs

Auto does not create PRs by itself. After a completed Auto Run, review the report and diff, then click Create Draft PR if GitHub readiness passes.

Requirements:

- The target project has a GitHub `origin` remote.
- `gh auth status` succeeds.
- The Auto Run completed successfully.

## Development

Run checks:

```bash
npm run test
npx tsc --noEmit
npm run lint
```

The repository includes tests for Auto data flow, readiness checks, recommended environments, the mini resolver, and runner behavior with fake mini results.

## Safety notes

- Do not commit `.env.local`; it is ignored by Git.
- Do not put production secrets in `NEXT_PUBLIC_*` variables.
- Assist file tools reject paths outside the active workspace.
- Assist command execution is allowlisted, not a hardened sandbox.
- Auto runs project code inside Docker by default, but the user should still review diffs and logs before applying changes or creating a PR.
- Auto requires a clean main Git workspace so generated changes do not mix with unfinished local work.

## Status

Thrush V2.0 is an early local product, not just a prototype: it has persistent projects, two agent modes, isolated Auto runs, environment readiness checks, artifacts, readable reports, and regression tests. It is still local-dev oriented and should be treated carefully around untrusted repositories and secrets.
