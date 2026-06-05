```markdown
# thrush-swe-agent Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns and conventions used in the `thrush-swe-agent` TypeScript codebase. You'll learn how to add new database-backed features, extend agent logic, follow project coding standards, and write tests in the established style. This guide is ideal for contributors aiming for consistency and maintainability.

## Coding Conventions

- **File Naming:**  
  Use `camelCase` for file names.  
  _Example:_  
  ```
  src/lib/agent/taskManager.ts
  src/types/agentTypes.ts
  ```

- **Import Style:**  
  Use alias imports for modules.  
  _Example:_  
  ```typescript
  import { fetchTasks as getTasks } from '../lib/agent/taskManager';
  ```

- **Export Style:**  
  Use named exports.  
  _Example:_  
  ```typescript
  // In src/lib/agent/taskManager.ts
  export function fetchTasks() { ... }
  export function assignTask() { ... }
  ```

- **Commit Messages:**  
  Freeform, no enforced prefix, average length ~29 characters.

## Workflows

### Add Database Feature with Migration
**Trigger:** When introducing a new database-backed feature or entity  
**Command:** `/new-db-feature`

1. **Create a new SQL migration file**  
   - Place it in `src/lib/db/migrations/`  
   - _Example:_  
     ```
     src/lib/db/migrations/20240610_add_projects.sql
     ```
2. **Update the data store logic**  
   - Edit `src/lib/db/store.ts` to handle new data operations.
   - _Example:_  
     ```typescript
     export function addProject(project: Project) { ... }
     ```
3. **Update or add relevant TypeScript types**  
   - Modify or create files in `src/types/` as needed.
   - _Example:_  
     ```typescript
     // src/types/project.ts
     export type Project = { id: number; name: string; };
     ```
4. **Implement or update feature logic in the agent**  
   - Edit or add files in `src/lib/agent/`.
   - _Example:_  
     ```typescript
     // src/lib/agent/projectManager.ts
     import { addProject } from '../db/store';
     ```
5. **Update or add API route handlers if necessary**  
   - Modify files in `src/app/api/*/route.ts` to expose new endpoints.

---

### Extend Agent Core Logic
**Trigger:** When enhancing or modifying the agent's core logic or behaviors  
**Command:** `/agent-logic-update`

1. **Update or add logic in agent files**  
   - Edit files in `src/lib/agent/` to implement new or improved behaviors.
   - _Example:_  
     ```typescript
     // src/lib/agent/taskAssigner.ts
     export function assignTaskToAgent(...) { ... }
     ```
2. **Update related TypeScript types**  
   - Edit `src/types/agent.ts` to reflect new agent capabilities.
   - _Example:_  
     ```typescript
     // src/types/agent.ts
     export interface Agent { ... newField: string; }
     ```
3. **Update or add API route handlers if agent behavior is exposed via API**  
   - Modify `src/app/api/*/route.ts` as needed.

---

## Testing Patterns

- **Test File Naming:**  
  Test files use the `*.test.*` pattern.  
  _Example:_  
  ```
  src/lib/agent/taskManager.test.ts
  ```
- **Framework:**  
  The specific testing framework is not detected.  
- **Test Location:**  
  Tests are typically placed alongside the code they test.

## Commands

| Command           | Purpose                                                      |
|-------------------|--------------------------------------------------------------|
| /new-db-feature   | Scaffold a new database-backed feature with migration steps  |
| /agent-logic-update | Update or extend agent core logic and related types        |
```
