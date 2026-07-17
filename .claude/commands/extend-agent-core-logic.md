---
name: extend-agent-core-logic
description: Workflow command scaffold for extend-agent-core-logic in thrush-swe-agent.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /extend-agent-core-logic

Use this workflow when working on **extend-agent-core-logic** in `thrush-swe-agent`.

## Goal

Enhances or modifies the agent's core logic, often updating multiple files in src/lib/agent/ and related type definitions.

## Common Files

- `src/lib/agent/*.ts`
- `src/types/agent.ts`
- `src/app/api/*/route.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update or add logic in multiple src/lib/agent/*.ts files
- Update related TypeScript types in src/types/agent.ts
- Update or add API route handlers if agent behavior is exposed via API

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.