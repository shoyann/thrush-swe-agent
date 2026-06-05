---
name: add-database-feature-with-migration
description: Workflow command scaffold for add-database-feature-with-migration in thrush-swe-agent.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-database-feature-with-migration

Use this workflow when working on **add-database-feature-with-migration** in `thrush-swe-agent`.

## Goal

Adds a new database-backed feature, including schema migration, updates to the data store, and related TypeScript types.

## Common Files

- `src/lib/db/migrations/*.sql`
- `src/lib/db/store.ts`
- `src/types/*.ts`
- `src/lib/agent/*.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create a new SQL migration file in src/lib/db/migrations/
- Update src/lib/db/store.ts to handle new data logic
- Update or add relevant TypeScript types in src/types/
- Implement or update feature logic in src/lib/agent/
- Update or add API route handlers if necessary

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.