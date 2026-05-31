<p align="center">
  <img src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" width="120" />
</p>

<h1 align="center">THRUSH</h1>

<p align="center">
  A self-hosted SWE agent that thinks before it acts —<br>
  plans tasks, calls tools to inspect your codebase,<br>
  and requires explicit approval before writing a single line.
</p>

<p align="center">
  <code>Next.js 15</code> · <code>TypeScript</code> · <code>DeepSeek</code> · <code>Playwright</code> · <code>SSE</code>
</p>

---

## What it does

| Capability | Detail |
|---|---|
| Agent loop | `Perceive → Think → Act` streamed to the UI in real time |
| Tool calling | Files, search, web, Git, GitHub issues, shell allowlist |
| Draft approval | Nothing writes to disk until you explicitly approve |
| Browser tools | Playwright-powered page reading and clicking |
| Safety boundary | Workspace sandboxed, SSRF blocked, commands allowlisted |
| Observability | Every run gets a unique `req_xxxxxx` ID with structured JSON logs |
| Auth | `POST /api/agent` protected by Bearer token |

## Quickstart

```bash
npm install
npm run dev
```

Add to `.env.local`:

```bash
DEEPSEEK_API_KEY=your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
AGENT_API_SECRET=your-secret
```

Open `http://localhost:3000`.

To point at a real project:

```bash
AGENT_WORKSPACE_ROOT=C:\your\project npm run dev
```

## Tool list

`click_page` · `git_inspect` · `list_files` · `read_file` · `read_page` · `replace_text` · `safe_command` · `search_text` · `web_search` · `write_file`

## Status

> **Small real agent, not yet full platform.**
> Works as a serious prototype. Missing: persistent sessions, multi-user isolation, test suite, production deployment.
