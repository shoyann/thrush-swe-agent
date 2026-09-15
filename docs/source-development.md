# Source development

This guide runs Thrush's browser UI from a source checkout. For the packaged Windows app, use the [desktop guide](desktop.md). For the product overview, return to the [README](../README.md).

## Prerequisites

- Git with submodule support.
- Node 22.22.3 and npm, matching the desktop build workflow.
- A model provider API key.
- For Auto: Python 3.12 with virtual-environment support, plus Docker for the default execution environment.
- For GitHub draft pull requests: an authenticated GitHub CLI (`gh`).

Run the commands below in the environment where Thrush will run. For WSL, keep Linux projects under `/home/<user>/...` and enable Docker Desktop's Ubuntu integration. Verify Docker from that environment with `docker info`.

## Start the browser app

### 1. Get the source and dependencies

```bash
git clone --recurse-submodules https://github.com/shoyann/thrush-swe-agent.git
cd thrush-swe-agent
npm ci
```

For an existing checkout, initialize any missing submodules with `git submodule update --init --recursive` before installing dependencies.

### 2. Configure model access

Copy the example settings in PowerShell:

```powershell
Copy-Item .env.local.example .env.local
```

Or in Bash / WSL:

```bash
cp .env.local.example .env.local
```

Edit `.env.local`. For DeepSeek, set:

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-api-key
AGENT_API_SECRET=replace-with-a-long-random-local-secret
```

Use your actual provider key and replace the secret placeholder. Keep `.env.local` out of Git; it is ignored by the repository.

During `npm run dev`, browser requests from the exact same localhost origin do not need an embedded token. Direct API clients still need `Authorization: Bearer <AGENT_API_SECRET>`. The `NEXT_PUBLIC_AGENT_API_SECRET` entry in the example file is a legacy setting; the current browser client does not read it, so you can remove it from your local copy. Never store private credentials in `NEXT_PUBLIC_*` variables, which are exposed to the browser.

### 3. Start Thrush

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). This is a local development workflow; desktop launch and packaging are covered separately in the [desktop guide](desktop.md#development-and-packaging).

### 4. Prepare Auto when needed

Before your first Auto run:

```bash
npm run bootstrap:mini
```

The bootstrap script creates `data/mini-venv`, installs the bundled `vendor/mini-swe-agent` and Python dependencies, checks imports, and writes `data/mini-venv/.ready.json`. The runtime is reused across runs.

The script uses `python` on Windows and `python3` elsewhere. You can override that executable with `PYTHON`; `UV_PATH` optionally selects a local `uv` executable for installation. Resolve the Auto readiness checks before starting: the target Git project must have no uncommitted changes, and the runtime, model key, and selected execution environment must be available.

## Environment variables

These settings apply to source development. The desktop app manages provider settings and credentials through its UI and supplies its own per-launch authentication token.

### Model settings

Defaults below describe the current code; model availability depends on your provider account.

| Name | Requirement | Default or purpose |
| --- | --- | --- |
| `MODEL_PROVIDER` | Optional | `deepseek` (default), `openai`, or `anthropic` |
| `DEEPSEEK_API_KEY` | Required for DeepSeek | Server-side provider key |
| `DEEPSEEK_BASE_URL` | Optional | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | Optional | `deepseek-v4-flash` |
| `OPENAI_API_KEY` | Required for OpenAI | Server-side provider key |
| `OPENAI_BASE_URL` | Optional | Custom OpenAI-compatible endpoint |
| `OPENAI_MODEL` | Optional | `gpt-4.1-mini` |
| `ANTHROPIC_API_KEY` | Required for the Anthropic gateway | Server-side provider key |
| `ANTHROPIC_BASE_URL` | Required for the Anthropic gateway | OpenAI-compatible gateway URL |
| `ANTHROPIC_MODEL` | Optional | `claude-sonnet-4-20250514` |

The Anthropic option uses an OpenAI-compatible gateway protocol. Supply a compatible endpoint when selecting it.

### App and runtime settings

| Name | Requirement | Default or purpose |
| --- | --- | --- |
| `AGENT_API_SECRET` | Required for direct `/api/agent` clients | Server-side Bearer token; local same-origin development browser requests are exempt |
| `AGENT_WORKSPACE_ROOT` | Optional | Default workspace path; otherwise `data/workspace` |
| `AGENT_MAX_TOOL_CALLS` | Optional | Maximum tool calls per Assist request; defaults to `4` |
| `AUTO_RUN_MINI_COMMAND` | Advanced | Override the mini runner command |
| `AUTO_RUN_MINI_ARGS_PREFIX_JSON` | Advanced | JSON array of arguments prepended to a custom mini command |
| `GH_PATH` | Optional | Absolute path to `gh.exe` or `gh` when it is not on `PATH` |

For desktop resource, data, runtime, and log directory overrides, see [desktop interfaces](desktop.md#interfaces).

## Local state and Auto artifacts

By default, source development stores generated state under `data/`:

| Path | Purpose |
| --- | --- |
| `data/thrush.db` | SQLite app database |
| `data/workspace` | Default sample workspace |
| `data/auto-runs/<autoRunId>/worktree` | Separate Git working copy for an Auto run |
| `data/auto-runs` | Auto artifacts, including reports, diffs, logs, and execution history |
| `data/mini-venv` | Generated Python runtime for bundled mini-swe-agent |
| `data/pip-cache`, `data/uv-cache` | Local dependency caches |

These generated files are ignored by Git. Desktop data uses [separate platform locations](desktop.md#runtime-profiles-and-data).

Auto uses branches named `auto/<autoRunId>`. Its normal status sequence is:

```text
queued → preparing → running → reporting → completed
```

Failures are categorized, including missing runtime or model configuration, unavailable Docker, uncommitted workspace changes, timeout, and cost limits. Runs can also be canceled. Review the result before explicitly creating a draft pull request; publishing requires a GitHub `origin` remote, `gh auth status` to succeed, and a successful run.

## Development checks

```bash
npm test
npm run test:desktop
npx tsc --noEmit
npm run lint
npm run build
```

The test suites cover Assist and Auto behavior, readiness checks, runtime resolution, data import, and desktop security. Live provider and Docker tests are separate opt-in checks that spend API credits; see [desktop verification](desktop.md#verification) before running them.

For staging both service bundles and producing the Windows installer, follow [desktop development and packaging](desktop.md#development-and-packaging). Historical design context lives in the [Auto technical design](design/auto-mode-technical-design.md) and [architecture decisions](adr).
