# Mini Codex MVP

This project is a stripped-down Codex-style SWE agent built with Next.js.

It already has four connected parts:

1. a chat UI
2. a backend API route
3. a real `Perceive -> Think -> Act` agent loop
4. a local tool system with safety gates

## What It Can Do Now

- show a chat interface with a visible step trace
- send tasks from the browser to `POST /api/agent`
- stream agent step updates back to the UI with Server-Sent Events
- call a real model through the OpenAI-compatible SDK
- decide whether to answer directly or use a tool
- read files, search text, and prepare file-change drafts
- require explicit approval before any file write reaches disk
- run a very small allowlist of local commands
- read live web pages, click simple page elements, and search the public web
- inspect Git and some GitHub environment details

## Tech Stack

- Next.js 15
- React 19
- TypeScript
- OpenAI Node SDK
- DeepSeek-compatible API base URL
- Playwright

## Project Shape

- `src/app`
  App pages, layout, global CSS, and API routes

- `src/app/api/agent`
  Backend route that validates requests and calls `runAgent`

- `src/components/chat`
  Chat UI, message list, step trace, and draft approval buttons

- `src/lib/agent`
  Main agent loop and planning flow

- `src/lib/tools`
  Tool registry plus all local tools

- `src/types`
  Shared request, response, message, step, and session types

- `data/workspace`
  Default demo workspace for file tools when no real project folder is configured

## Current Tool List

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

## Workspace Setup

By default, file tools work inside:

- `data/workspace`

You can point the agent at a real project folder with:

- `AGENT_WORKSPACE_ROOT`

Example in PowerShell:

```powershell
$env:AGENT_WORKSPACE_ROOT="C:\Users\Administrator\Documents\my-real-project"
npm run dev
```

If `AGENT_WORKSPACE_ROOT` is empty, the agent keeps using the demo workspace.

## Model Setup

Create `.env.local` with values like:

```powershell
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

The backend currently expects `DEEPSEEK_API_KEY` to exist before the real agent loop can run.

## Safety Boundary

Think of the workspace root like the fence around one allowed yard.
The agent can work inside that yard, but it should not step outside it.

Current safety rules in this MVP:

- file paths are resolved against the configured workspace root
- a path outside that root is rejected
- write operations go through a draft first
- nothing is written until the user approves the draft
- `safe_command` only allows a very small whitelist

Current `safe_command` allowlist:

- `git status`
- `npm run build`
- `npm test` only if the workspace has a `test` script
- `rg` search
- `rg --files`

Blocked examples:

- shells like `bash`, `powershell`, `cmd`
- network download tools like `curl`, `wget`
- scripting runtimes like `python`, `node`
- destructive commands like `rm`, `del`, `move`

## How To Run

From the project folder:

```powershell
npm install
npm run dev
```

Then open:

- `http://127.0.0.1:3000`
- or `http://localhost:3000`

## Build Check

Current verified command:

```powershell
npm run build
```

This passed successfully on 2026-05-28.

## Known Gaps

- no formal automated test suite in the repo yet
- no database or persistent task history
- no user accounts or auth
- pending drafts live in server memory, so restart behavior is limited
- docs can drift quickly because the project is changing fast
