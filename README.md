<p align="center">
  <img src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" width="120" />
</p>

<h1 align="center">THRUSH</h1>

<p align="center">
  A self-hosted SWE agent that thinks before it acts<br>
  plans tasks, calls tools to inspect your codebase,<br>
  and requires explicit approval before writing a single line.
</p>

<p align="center">
  <code>Next.js 15</code> | <code>TypeScript</code> | <code>DeepSeek</code> | <code>Playwright</code> | <code>SSE</code>
</p>

---

## What it does

| Capability | Detail |
|---|---|
| Agent loop | `Perceive -> Think -> Act` streamed to the UI in real time |
| Tool calling | Files, search, web, Git, GitHub issues, shell allowlist |
| Draft approval | Nothing writes to disk until you explicitly approve |
| Browser tools | Playwright-powered page reading and clicking |
| Safety boundary | Workspace sandboxed, SSRF blocked, commands allowlisted |
| Observability | Every run gets a unique `req_xxxxxx` ID with structured JSON logs |
| Auth | `POST /api/agent` protected by Bearer token |

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Copy the environment example:

```powershell
Copy-Item .env.local.example .env.local
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

Then restart `npm run dev`.

## Environment variables

| Name | Required | Purpose |
|---|---:|---|
| `DEEPSEEK_API_KEY` | Yes | API key used by the server-side agent loop |
| `DEEPSEEK_BASE_URL` | No | DeepSeek-compatible API base URL; defaults to `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | No | Model name; defaults to `deepseek-v4-flash` |
| `AGENT_API_SECRET` | Yes | Server-side Bearer token required by `/api/agent` |
| `NEXT_PUBLIC_AGENT_API_SECRET` | Local dev only | Browser-side token used by the local UI to call `/api/agent` |
| `AGENT_WORKSPACE_ROOT` | No | Absolute folder path the agent is allowed to inspect and draft edits inside |
| `GH_PATH` | No | Absolute path to `gh.exe` if GitHub CLI is not on `PATH` |

## Security notes

- Do not commit `.env.local`; it is ignored by Git.
- Do not put real production secrets in `NEXT_PUBLIC_AGENT_API_SECRET`. Any `NEXT_PUBLIC_*` value is shipped to the browser, so users can inspect it.
- The current browser UI auth is suitable for local development only. For production, put the UI behind real user authentication and keep the server token server-only.
- `AGENT_WORKSPACE_ROOT` is the main file boundary. The file tools reject paths outside this folder.

## Tool list

`click_page` | `git_inspect` | `list_files` | `read_file` | `read_page` | `replace_text` | `safe_command` | `search_text` | `web_search` | `write_file`

## Known gaps

- Test coverage is still narrow. The current `test` script focuses on `safe_command`; agent loop, API route, file tools, and browser tools still need tests.
- File reading supports line windows; file listing is still one folder at a time, with no tree summary tool yet.
- Draft storage is in memory, so a server restart loses pending drafts.
- `NEXT_PUBLIC_AGENT_API_SECRET` makes local UI auth simple, but it is not a production-grade auth design.

## Status

> Thrush is a minimal, self-hosted SWE agent that plans, inspects, and edits code with human approval.
