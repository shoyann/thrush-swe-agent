<p align="center">
  <img src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" width="120" />
</p>

<h1 align="center">THRUSH</h1>

<p align="center">
  A self-hosted SWE agent workbench that thinks before it acts<br>
  plans tasks, calls tools to inspect your codebase,<br>
  and requires explicit approval before writing a single line.
</p>

<p align="center">
  <code>Next.js 15</code> | <code>TypeScript</code> | <code>SQLite</code> | <code>DeepSeek</code> | <code>Playwright</code> | <code>SSE</code>
</p>

---

## What it does

| Capability | Detail |
|---|---|
| Agent loop | Lean `Perceive -> Think -> Act` loop streamed to the UI in real time |
| Tool calling | Files, tree listing, search, web, Git, GitHub issues, and shell allowlist |
| Agent architecture | Tool result hooks, think strategies, and direct tool plan rules keep the main loop small |
| Draft approval | File edits are prepared as drafts and only written after explicit user approval |
| Project workspace | Each project points at a local workspace folder; tools are sandboxed to that folder |
| Session state | Projects, sessions, messages, tool runs, and checkpoints are stored locally in SQLite |
| Workspace switching | A session can switch to another local workspace after confirmation, with optional read-only mode |
| Browser tools | Playwright-powered page reading and clicking |
| Safety boundary | Workspace path validation, SSRF checks, command allowlist, and write approval gate |
| Observability | Every run gets a unique `req_xxxxxx` ID with structured JSON logs |
| Auth | `POST /api/agent` is protected by a Bearer token |
| Model client | DeepSeek by default, with provider-aware configuration for OpenAI-compatible clients |

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Copy the environment example:

```powershell
Copy-Item .env.local.example .env.local
```

On macOS or Linux:

```bash
cp .env.local.example .env.local
```

3. Edit `.env.local` and set at least these values:

```bash
DEEPSEEK_API_KEY=your-deepseek-api-key
AGENT_API_SECRET=replace-with-a-long-random-local-secret
NEXT_PUBLIC_AGENT_API_SECRET=replace-with-the-same-local-secret
```

4. Start the app:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Point at a real project

By default, Thrush only sees `data/workspace`.

To let it inspect a real local project, set `AGENT_WORKSPACE_ROOT` in `.env.local`:

```bash
AGENT_WORKSPACE_ROOT=C:\your\project
```

On macOS or Linux:

```bash
AGENT_WORKSPACE_ROOT=/path/to/your/project
```

Then restart `npm run dev`.

You can also create projects from the UI. Each project stores its own workspace path, sessions, messages, tool runs, and checkpoints in the local SQLite database at `data/thrush.db`.

## Environment variables

| Name | Required | Purpose |
|---|---:|---|
| `MODEL_PROVIDER` | No | Model provider selector; supports `deepseek`, `openai`, or `anthropic`; defaults to `deepseek` |
| `DEEPSEEK_API_KEY` | Yes, unless another provider is selected | API key used by the server-side agent loop |
| `DEEPSEEK_BASE_URL` | No | DeepSeek-compatible API base URL; defaults to `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | No | Model name; defaults to `deepseek-v4-flash` |
| `OPENAI_API_KEY` | If `MODEL_PROVIDER=openai` | OpenAI API key |
| `OPENAI_BASE_URL` | No | Optional OpenAI-compatible API base URL override |
| `OPENAI_MODEL` | If `MODEL_PROVIDER=openai` | OpenAI model name; defaults to `gpt-4.1-mini` |
| `ANTHROPIC_API_KEY` | If `MODEL_PROVIDER=anthropic` | Anthropic API key for an OpenAI-compatible Anthropic gateway |
| `ANTHROPIC_BASE_URL` | If `MODEL_PROVIDER=anthropic` | OpenAI-compatible Anthropic gateway URL |
| `ANTHROPIC_MODEL` | If `MODEL_PROVIDER=anthropic` | Anthropic model name; defaults to `claude-sonnet-4-20250514` |
| `AGENT_API_SECRET` | Yes | Server-side Bearer token required by `/api/agent` |
| `NEXT_PUBLIC_AGENT_API_SECRET` | Local dev only | Browser-side token used by the local UI to call `/api/agent` |
| `AGENT_WORKSPACE_ROOT` | No | Default absolute folder path the agent is allowed to inspect and draft edits inside |
| `AGENT_MAX_TOOL_CALLS` | No | Maximum tool calls per agent run; defaults to `4` |
| `GH_PATH` | No | Absolute path to `gh.exe` if GitHub CLI is not on `PATH` |

## Tool list

`click_page` | `git_inspect` | `list_files` | `read_file` | `read_page` | `replace_text` | `safe_command` | `search_text` | `tree_files` | `web_search` | `write_file`

## Tool behavior

| Tool | Purpose |
|---|---|
| `list_files` | Lists one folder inside the workspace |
| `tree_files` | Returns a shallow tree summary of files and folders |
| `read_file` | Reads a file, with optional line windows |
| `search_text` | Searches workspace text with ripgrep |
| `write_file` | Prepares a full-file write draft; does not write immediately |
| `replace_text` | Prepares an exact text replacement draft; does not write immediately |
| `safe_command` | Runs a small allowlist of local commands such as `git status`, build, test, lint, `rg`, `pytest`, `ruff`, `cargo`, or `make` |
| `git_inspect` | Reads Git state, diffs, GitHub readiness, issues, issue details, issue plans, PR drafts, and patch exports |
| `web_search` | Searches the public web and returns a short list of titles and links |
| `read_page` | Opens a public page in Playwright and returns visible text |
| `click_page` | Opens a public page, clicks one simple selector, and returns the resulting page text |

## Write approval flow

Thrush never writes directly when the model proposes a file edit.

File modification tools return a draft first:

```text
Write file draft only. Nothing was written to disk.
Draft id: draft-...
Reply with APPROVE_WRITE draft-... to write this file.
Reply with CANCEL_WRITE draft-... to discard this draft.
```

The user must explicitly approve the draft before Thrush writes to disk.

Short replies like `approve`, `cancel`, `批准`, or `取消` are also supported when there is exactly one pending draft in the current session.

## Security notes

- Do not commit `.env.local`; it is ignored by Git.
- Do not put real production secrets in `NEXT_PUBLIC_AGENT_API_SECRET`. Any `NEXT_PUBLIC_*` value is shipped to the browser, so users can inspect it.
- The current browser UI auth is suitable for local development only. For production, put the UI behind real user authentication and keep the server token server-only.
- `AGENT_WORKSPACE_ROOT` and project workspace paths are the main file boundaries. File tools reject paths outside the active workspace.
- URL tools block localhost, loopback, and private network ranges to reduce SSRF risk.
- `safe_command` is an allowlist, not a full sandbox. Build and test commands can still execute project code.
- Do not run Thrush against untrusted repositories unless you understand the local execution risk.

## Local state

Thrush stores local app state in SQLite:

```text
data/thrush.db
```

The database stores:

- projects
- sessions
- messages
- tool runs
- checkpoints
- session context, including pending write drafts after a run completes

Pending drafts are persisted in session context after the agent run finishes. A server crash in the middle of a run may still lose a just-created draft before it is saved.

## Known gaps

- Test coverage is still narrow. The current `test` script focuses on `safe_command`; agent loop, API routes, file tools, browser tools, workspace switching, and GitHub issue flows still need dedicated tests.
- The main loop is modular, but `onResult`, think strategies, direct plan rules, model provider paths, and draft lifecycle flows need broader coverage.
- `tree_files` exists, but it is intentionally shallow and capped; large repository exploration still needs better summaries.
- The UI auth model is local-dev oriented. Production deployments need real user authentication and server-only secrets.
- File edit review is still text-based. A proper diff viewer would make draft approval safer.
- Command execution is allowlisted, but not isolated in a Docker or VM sandbox.
- GitHub issue and PR features depend on local Git state, remotes, `gh`, and GitHub authentication being configured correctly.

## Status

> Thrush is a local, self-hosted SWE agent workbench that plans, inspects, and edits code with human approval.
