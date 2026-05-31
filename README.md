# Thrush
<img width="248" height="274" alt="b61bf25a6fc699a282e40d63ce052b3d" src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" />


Thrush is a lightweight SWE agent workspace built with Next.js.

It is designed as a small but real coding agent:

- browser chat UI
- backend agent loop
- streaming step trace
- local tool calling
- draft-based file write approval

This repo is not a mock shell anymore. The agent can already plan, call tools, inspect code, prepare edits, and return step-by-step output in the UI.

## What Thrush Does

Thrush currently supports:

- sending tasks from the browser to `POST /api/agent`
- streaming `Perceive -> Think -> Act` events back to the UI
- deciding between direct answers and tool use
- reading files and searching text inside a workspace
- preparing file-write and replace-text drafts before touching disk
- requiring explicit approval for writes
- running a small allowlist of local commands
- reading live pages and clicking simple page elements with Playwright
- searching the public web
- inspecting Git and basic GitHub state
- turning GitHub issue detail into a structured execution plan

## Product Shape

The current app is built from four connected layers:

1. `src/components/chat`
   The browser chat shell, message feed, draft approval UI, and streamed step rendering.

2. `src/app/api/agent/route.ts`
   The backend route that validates input and runs the agent loop.

3. `src/lib/agent/run-agent.ts`
   The main agent brain. This is where planning, tool choice, and response assembly happen.

4. `src/lib/tools`
   The tool registry plus local tools for files, commands, web inspection, and Git/GitHub checks.

## Current Tool List

Thrush currently registers these tools:

- `click_page`
- `git_inspect`
- `list_files`
- `read_file`
- `read_page`
- `replace_text`
- `safe_command`
- `search_text`
- `web_search`
- `write_file`

## Tech Stack

- Next.js 15
- React 19
- TypeScript
- OpenAI Node SDK
- DeepSeek-compatible API endpoint
- Playwright

## Workspace Model

By default, file tools work inside:

- `data/workspace`

You can point Thrush at a real project folder with:

- `AGENT_WORKSPACE_ROOT`

Example in PowerShell:

```powershell
$env:AGENT_WORKSPACE_ROOT="C:\Users\Administrator\Documents\my-real-project"
npm run dev
```

If `AGENT_WORKSPACE_ROOT` is not set, Thrush keeps using the demo workspace.

## Model Setup

Create `.env.local` with values like:

```powershell
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

The agent currently expects `DEEPSEEK_API_KEY` to exist before the real loop can run.

## Safety Model

Thrush uses a small safety boundary rather than full sandbox isolation.

Current protections:

- file paths are resolved against the configured workspace root
- paths outside the workspace root are rejected
- write operations become drafts first
- nothing is written until the draft is explicitly approved
- local commands go through a strict allowlist
- browser URL access blocks private and loopback targets
- browser tools reject `localhost`, private IP ranges, and cloud metadata endpoints

Current `safe_command` allowlist:

- `git status`
- `npm run build`
- `npm test` only when the workspace has a `test` script
- `rg` search
- `rg --files`

Blocked examples:

- shells like `bash`, `powershell`, `cmd`
- download tools like `curl`, `wget`
- scripting runtimes like `python`, `node`
- destructive commands like `rm`, `del`, `move`

## Security

Thrush now includes a few concrete server-side protections:

- `POST /api/agent` is protected by a Bearer token using `AGENT_API_SECRET`
- browser tools reject private-network targets to reduce SSRF risk
- the GitHub CLI wrapper supports `GH_PATH` as an environment-variable override for local or non-standard installs

## Observability

Each agent run now gets a unique request ID.

The backend emits structured JSON logs at the key lifecycle points, including request start, loop iteration start, tool dispatch, tool completion, successful completion, and failure.

## UI Notes

The current UI is branded as `Thrush` and includes:

- top-left product branding and icon
- chat feed with streamed assistant output
- visible thinking trace
- draft approval buttons
- sticky trace panel on larger screens

This is still a developer-facing interface, not a polished end-user SaaS product.

## How To Run

From the project folder:

```powershell
npm install
npm run dev
```

Then open:

- `http://127.0.0.1:3000`
- `http://localhost:3000`

## Verified Build

The current production build command is:

```powershell
npm run build
```

This was verified successfully again after the latest UI and agent updates.

## What This Repo Is Good For

Thrush is a good fit if you want to:

- prototype coding-agent loops
- experiment with tool-calling behavior
- test approval-gated file editing
- try issue-to-plan coding workflows
- evolve a small SWE agent toward a larger architecture later

## Current Gaps

Thrush is still missing several things you would want in a broader public-facing agent platform:

- no formal automated test suite in the repo yet
- no database or durable session storage
- pending draft state still depends on in-memory flow
- no multi-user workspace isolation
- no production deployment setup in this repo
- no long-term memory system
- no multi-agent orchestration layer

## Practical Status

The simplest accurate description of the repo today is:

`small real agent, not yet full platform`

It already works as a serious prototype, but it is still closer to an operator workspace than a finished product.
