# Handoff

## Project


Goal: build a stripped-down Codex-style SWE agent that stays understandable while still using a real backend loop and real tools.

## Current State

This is no longer a mock-agent stage project.

The app already has:

- a real chat page
- a real backend route at `POST /api/agent`
- streaming step updates with SSE
- a real `runAgent()` loop in `src/lib/agent/run-agent.ts`
- real tool registration and execution
- draft-based file writing with explicit approval

## What Is Done

### 1. Frontend chat shell

Main file:

- `src/components/chat/chat-shell.tsx`

Current UI behavior:

- user can type a task and send it
- frontend sends the request to `/api/agent`
- frontend reads streamed `steps`, `message`, and `done` events
- frontend shows a step trace beside the chat
- frontend shows YES / NO buttons when a pending draft exists

### 2. Backend API route

Main file:

- `src/app/api/agent/route.ts`

Current behavior:

- validates request JSON
- rejects empty tasks
- supports normal JSON response mode
- supports streaming SSE mode
- calls `runAgent(task, messages, sessionContext, options)`

### 3. Real agent loop

Main file:

- `src/lib/agent/run-agent.ts`

Current behavior:

- normalizes task and recent conversation
- keeps lightweight session context
- emits `Perceive -> Think -> Act` steps
- can answer directly or choose tools
- supports up to 4 tool calls per task
- formats final answers from model text or tool results

### 4. Tool system

Registry file:

- `src/lib/tools/tool-registry.ts`

Current registered tools:

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

### 5. File draft safety gate

Main files:

- `src/lib/tools/write-file.ts`
- `src/lib/tools/replace-text.ts`
- `src/lib/tools/pending-write.ts`

Current behavior:

- file writes do not hit disk immediately
- write requests become drafts first
- drafts can be approved or canceled
- backend only writes after explicit approval
- ambiguous confirmations are intentionally rejected

### 6. Workspace boundary

Main file:

- `src/lib/tools/workspace-path.ts`

Current behavior:

- defaults to `data/workspace`
- can switch to a real folder with `AGENT_WORKSPACE_ROOT`
- rejects paths outside the configured workspace
- returns clear errors for missing or invalid workspace roots

### 7. Model connection

Current model wiring:

- SDK: `openai`
- API key env: `DEEPSEEK_API_KEY`
- base URL env: `DEEPSEEK_BASE_URL`
- model env: `DEEPSEEK_MODEL`

If `DEEPSEEK_API_KEY` is missing, the real loop fails early on purpose.

## Current Architecture

1. User types a task in the browser.
2. Frontend sends `{ task, messages, sessionContext, stream: true }` to `/api/agent`.
3. API route calls `runAgent(...)`.
4. Agent emits step updates.
5. Agent may call tools.
6. Agent returns either:
   - a direct answer
   - a tool-backed answer
   - or a draft awaiting approval
7. Frontend updates chat, trace panel, and draft controls.

## Files That Matter Most

- `src/lib/agent/run-agent.ts`
  Real agent loop and tool-planning logic

- `src/app/api/agent/route.ts`
  Backend entry and streaming response logic

- `src/components/chat/chat-shell.tsx`
  Frontend request flow, streaming reader, and draft approval UI

- `src/lib/tools/tool-registry.ts`
  Single source of truth for available tools

- `src/lib/tools/pending-write.ts`
  Pending draft storage and final write application

- `src/types/agent.ts`
  Shared message, step, request, response, and session shapes

## What Has Been Verified

- `npm install` completed earlier in the project
- `npm run build` passed successfully on 2026-05-28
- current route structure compiles with Next.js production build
- tool registry is wired to the backend loop
- streaming route code is present and connected

## Known Gaps

- no formal test suite is checked into the repo
- `package.json` has no `test` script
- pending draft state is in memory, not persistent storage
- no user accounts, auth, or database
- docs may drift if they are not updated after feature work
- some root log files may be locked by running local processes

## Recommended Next Steps

1. Add the smallest possible automated tests.
   Start with `run-agent.ts`, `write-file.ts`, `replace-text.ts`, and `safe-command.ts`.

2. Improve draft review UX.
   Show a clearer before/after diff instead of only raw draft text.

3. Persist draft and session state.
   Right now a server restart can break pending draft flow.

4. Tighten error structure.
   Several failures still come back mainly as plain text.

5. Decide whether this stays a teaching demo or becomes a more product-like app.
   That decision changes how much auth, storage, and deployment work should be added.

## Suggested Prompt For The Next Thread

```text
Read HANDOFF.md and continue from the current state.
Do not revert existing work.
Keep changes small and explain them clearly.

First, inspect the current code and confirm the real agent loop, tool registry, and draft approval flow.
Then do exactly one next improvement:
add the smallest useful automated test coverage for the current tool and agent flow.
```
