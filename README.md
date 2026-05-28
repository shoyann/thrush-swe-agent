# Mini Codex MVP

This project is a stripped-down Codex-style SWE agent.

## Workspace setup

By default, the file tools work inside:

- `data/workspace`

You can point the agent at a real project folder by setting:

- `AGENT_WORKSPACE_ROOT`

Example in PowerShell:

```powershell
$env:AGENT_WORKSPACE_ROOT="C:\Users\Administrator\Documents\my-real-project"
npm run dev
```

If you do not set `AGENT_WORKSPACE_ROOT`, the agent keeps using the default demo folder.

## Safety boundary

Think of the workspace root like the front gate of one allowed building.
The agent can move around inside that building, but it still cannot walk outside it.

Current file tools that follow the configured workspace root:

- `list_files`
- `read_file`
- `search_text`
- `write_file`

Safety rules in this MVP:

- paths are still checked against the configured workspace root
- a path outside that root is rejected
- if `AGENT_WORKSPACE_ROOT` points to a folder that does not exist, the backend returns a clear error
- if `AGENT_WORKSPACE_ROOT` points to a file instead of a folder, the backend returns a clear error

## Folder map

- `src/app`: web app pages and API routes
- `src/app/api/agent`: backend entry for the agent loop
- `src/components/chat`: chat UI pieces
- `src/lib/agent`: perception -> thinking -> action loop code
- `src/lib/tools`: local tools like file read/write and safe command execution
- `src/lib/search`: web search wrapper
- `src/types`: shared data shapes
- `public`: static assets
- `data/workspace`: default demo workspace when `AGENT_WORKSPACE_ROOT` is not set

## Build order

1. Create the app shell and install dependencies
2. Build the chat UI
3. Add the backend API
4. Add the agent loop
5. Add the three base tools
6. Stream step-by-step status to the UI
