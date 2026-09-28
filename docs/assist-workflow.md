# Assist task workflow

Assist now owns a durable task lifecycle instead of ending a task whenever a tool returns text.

## User behavior

- The model records the full task with `task_plan`, then inspects, drafts, applies authorized changes, and verifies them.
- `safe_command` returns observed command results. A passing baseline test does not finish an implementation task. Failed checks stay available to guide the next edit.
- With automatic approval enabled, each draft is applied and the same run continues. With manual approval, the run pauses; approval resumes the original objective and its remaining checks.
- `继续`, `请继续…`, `continue`, and `resume` retain the task objective. Additional instructions are recorded as steering. Use `新任务：...` or `new task: ...` to replace an unfinished task once no draft is pending. Cancel discards a pending draft and ends that task.
- The chat shows the saved objective, plan, changed-file count, verification state, and a Continue button for paused/interrupted tasks.

## Architecture and extension points

| Module                            | Responsibility                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/lib/agent/workflow.ts`       | Versioned state, normalization, write revisions, completion rules, bounded journal                            |
| `src/lib/agent/run-agent.ts`      | One controller for planning, execution, approval, checkpoints and stopping                                    |
| `src/lib/tools/task-control.ts`   | Model-visible plan/finish schemas; only the controller applies these decisions                                |
| `src/lib/agent/agent-thinking.ts` | Model adapter with full objective and observations; no keyword command dispatch or forced edit after one read |
| `src/lib/tools/safe-command.ts`   | Existing command allowlist, execution and structured exit-code evidence                                       |
| `src/lib/tools/pending-write.ts`  | Workspace-scoped writes and stale-draft preconditions                                                         |
| `src/app/api/agent/route.ts`      | Per-session single-run guard, persistence and stream lifetime                                                 |

To add a tool, register its schema and executor. Return observations, not task completion policy. Tools cannot mark a task complete. Keep cross-tool lifecycle decisions in the controller and evidence rules in `workflow.ts`.

To change workflow storage, add a version-specific normalizer/migration. Current state is stored in the existing session `context_json` column, so existing databases require no schema migration. Sessions without workflow state remain readable. On explicit resume or approval, the latest non-control user request is recovered from legacy history when available; a fresh plan and fresh verification are required. Existing pending drafts can still be approved.

## Completion contract

1. `finish_task(completed)` requires a plan and no pending draft. Change tasks require an applied file write.
2. Every declared command must have an observed successful exit after the latest applied edit. Editing any file invalidates earlier check results. Resuming also invalidates prior checks because files may have changed externally.
3. A plan may add checks but may not remove them or change task kind to bypass requirements. Real verification commands automatically join the required checks even if the initial plan omitted them. If checks are unavailable, `finish_task(unverified)` leaves a resumable, visibly unverified task; it cannot be marked completed. Requested tests must not be waived merely to finish.
4. Blocked work or missing user information is recorded as blocked, never completed. Execution limits pause the task for continuation.

These are mechanical evidence gates, not proof that a model's plan or tests cover every user requirement. Independent acceptance tests remain necessary for meaningful evaluations. Shell scripts can change files outside the file tools; they remain trusted project code, not a hardened sandbox. Separate sessions may target the same project; the per-session guard is not a project-wide transaction or multi-server lock.

## Durability and interruption

State is saved before a tool or authorized write and after its outcome. The objective and plan are separate from conversational summaries. A bounded journal retains the last 24 observations (up to 3,000 characters each); full tool runs remain in the existing tool-run store. Resume uses the objective, plan and journal, and rereads files as needed instead of replaying old writes blindly.

An in-flight action saved before a crash is marked uncertain. A pending approved write whose exact content is already on disk is idempotent; an externally changed file rejects the stale draft. Legacy drafts created before this upgrade lack the content precondition. Filesystem comparison and write are not an atomic transaction against other processes.

Client disconnects propagate cancellation to model requests and command execution. The controller checks cancellation between actions and before writing. Model requests have a 90-second timeout and one retry; commands have a 120-second timeout. Process termination is best effort for grandchildren started by project scripts. A recovered `running` task shows Interrupted when the UI has no active request.

## Limits

| Setting                |                               Default | Maximum |
| ---------------------- | ------------------------------------: | ------: |
| `AGENT_MAX_TOOL_CALLS` | 24 per turn (including control calls) |     100 |
| `AGENT_MAX_RUN_MS`     |                                600000 | 3600000 |

Time limits are checked between actions; an action can run up to its own timeout. Three consecutive identical failing tool calls block the task. Two consecutive plain-text replies during an active task pause it instead of reporting a false completion.

## Regression checks

Run `npm ci`, `npm test`, `npm run lint`, and `npm run build`.

`test/assist-workflow.test.ts` replaces only the model planner; it exercises the production controller, real temporary files, actual write approvals and real `npm test` subprocesses. Cases include failure → edit → retest, baseline pass without edits, multiple files, stale checks, manual approval, serialized continuation after a budget pause, Chinese continuation, read-only, stale drafts, repeated failures, workspace mismatch and cancellation.

`scripts/test-alias.cjs` resolves TypeScript's `@/` imports in the compiled Node test process only. Production uses Next's normal alias handling. No new runtime dependency is introduced.
