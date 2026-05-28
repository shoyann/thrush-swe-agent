# Handoff

## Project

Mini Codex MVP in:

`C:\Users\Administrator\Documents\Codex\2026-05-26\vibe-coding-swe-agent`

Goal: build a stripped-down Codex-style SWE agent step by step, in a way a non-technical user can follow.

## What Is Done

### 1. Project skeleton

Created the main folders:

- `src/app`
- `src/app/api/agent`
- `src/components/chat`
- `src/lib/agent`
- `src/lib/tools`
- `src/lib/search`
- `src/types`
- `public`
- `data/workspace`

### 2. Next.js app shell

Set up:

- `package.json`
- `tsconfig.json`
- `next.config.ts`
- `next-env.d.ts`
- `.gitignore`
- base app layout and CSS

Build passes with:

```powershell
npm run build
```

### 3. Chat UI MVP

Built a basic chat interface:

- task input box
- send button
- chat message list
- right-side trace panel for `Perceive -> Think -> Act`

Main files:

- `src/components/chat/chat-shell.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`

### 4. Backend API path

Connected the frontend to a real backend route:

- `POST /api/agent`

Main files:

- `src/app/api/agent/route.ts`
- `src/lib/agent/mock-agent.ts`
- `src/types/agent.ts`

Current behavior:

- frontend sends task to `/api/agent`
- backend returns a mock assistant message
- backend also returns 3 mock steps
- frontend renders both

## Current Architecture

Very simple version right now:

1. User types a task in the browser
2. Frontend sends `{ task }` to `/api/agent`
3. API route calls `runMockAgent(task)`
4. Mock agent returns:
   - one assistant message
   - one array of steps
5. Frontend displays both

This means the request path is real, but the agent brain is still fake.

## How To Run

From the project folder:

```powershell
npm install
npm run dev
```

Then open:

- `http://127.0.0.1:3000`
- or `http://localhost:3000`

## Files That Matter Most

- `src/components/chat/chat-shell.tsx`
  Frontend chat UI and request sending

- `src/app/api/agent/route.ts`
  Backend API entry

- `src/lib/agent/mock-agent.ts`
  Temporary fake agent logic

- `src/types/agent.ts`
  Shared request/response/message/step shapes

- `src/app/globals.css`
  Current UI styling

## What Has Been Verified

- `npm install` completed
- `npm run build` completed successfully
- local API request to `http://127.0.0.1:3000/api/agent` returned valid JSON
- user confirmed page could be opened manually

## Important Constraints From The User

Keep working in very small steps.

For each step:

- finish one feature only
- stop and explain in very plain language
- explain new technical words with a life analogy first
- say clearly what the next step is

Do not jump too far ahead.

## Next Recommended Step

Replace `mock-agent.ts` with a real agent loop skeleton.

That next step should still stay minimal:

1. Add a real `perceive -> think -> act` function structure
2. Keep model output fake for now if needed
3. Separate the loop into explicit stages in code
4. Return richer step data from that loop

The goal of the next step is not real tools yet.
The goal is to make the backend code structure look like an actual agent.

## After That

Suggested order after the next step:

1. real agent loop skeleton
2. streaming or pseudo-real-time step updates
3. OpenAI API call
4. tool registry
5. file read/write tool
6. safe command tool
7. web search tool
8. tool-use decision logic

## Known Gaps

- no real LLM call yet
- no real tool use yet
- no streaming updates yet
- no persistence or memory yet
- no command safety policy yet
- no env var setup for API keys yet

## Suggested Prompt For The Next Thread

Use this as the first message in the new thread:

```text
Read HANDOFF.md and continue from the current state.
Do not redo completed work.
Follow the existing workflow:
1. only implement one small feature at a time
2. after each feature, stop and explain in very plain Chinese
3. explain any new technical term with a life analogy first
4. always tell me what the next step is

Now do the next recommended step from HANDOFF.md:
replace the mock agent with a real perceive -> think -> act loop skeleton, but keep it minimal and runnable.
```
