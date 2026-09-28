import type {
  AgentResponse,
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";
import { listTools, getTool } from "@/lib/tools/tool-registry";
import {
  getWorkspaceRoot,
  withWorkspaceRoot,
} from "@/lib/tools/workspace-path";
import { applyPendingWriteDraft } from "@/lib/tools/pending-write";
import {
  normalizeSessionContext,
  prepareConversationContext,
} from "./conversation-context";
import { getConfiguredModelName } from "./model-client";
import {
  createMessage,
  createStep,
  emitStepsSnapshot,
  finishAgentRun,
  type RunAgentOptions,
} from "./agent-response";
import { formatToolExecutionInput } from "./tool-args";
import {
  MAX_TOOL_CALLS,
  MAX_RUN_MS,
  createSyntheticToolCallId,
  type ToolRun,
} from "./tool-run-types";
import { buildNextSessionContext } from "./session-state";
import {
  parseDraftLifecycleAction,
  parseWriteCommand,
} from "./draft-lifecycle";
import { runToolCall } from "./tool-runner";
import { perceive, think, type AgentContext } from "./agent-thinking";
import {
  completionProblem,
  isContinueRequest,
  isUnfinished,
  newWorkflow,
  recordWrite,
  remember,
  type WorkflowPlan,
} from "./workflow";
import { withExecutionSignal } from "./execution-context";
import type { ToolResult } from "../tools/types";

// A small dependency boundary lets regression tests exercise the real controller and
// real filesystem tools while replacing only the nondeterministic model planner.
const defaultRuntime = {
  think,
  prepareConversationContext,
  getConfiguredModelName,
  runToolCall,
  applyPendingWriteDraft,
};
type AgentRuntime = typeof defaultRuntime;

export function createAgentRunner(overrides: Partial<AgentRuntime> = {}) {
  const runtime = { ...defaultRuntime, ...overrides };
  const run = async function run(
    task: string,
    messages: ChatMessage[] = [],
    initialContext: AgentSessionContext = {},
    _requestId: string,
    options: RunAgentOptions = {},
  ): Promise<AgentResponse> {
    const startedAt = Date.now();
    let session = normalizeSessionContext(initialContext);
    session = {
      ...session,
      projectId: options.projectId ?? session.projectId,
      sessionId: options.sessionId ?? session.sessionId,
    };
    const steps: AgentStep[] = [];
    const checkpoint = async () => {
      await options.onCheckpoint?.(
        structuredClone(session),
        structuredClone(steps),
      );
      await options.onEvent?.({
        type: "workflow",
        workflow: session.workflow ?? null,
      });
    };
    const finish = async (message: string) => {
      await checkpoint();
      return finishAgentRun(
        { message: createMessage(message), sessionContext: session, steps },
        options.onEvent,
        true,
      );
    };
    const stop = async (
      status: "paused" | "blocked" | "awaiting_approval" | "cancelled",
      reason: string,
    ) => {
      if (session.workflow) {
        session.workflow.status = status;
        session.workflow.reason = reason;
      }
      return finish(reason);
    };
    const inWorkspace = <T>(fn: () => Promise<T>) =>
      options.workspaceRoot
        ? withWorkspaceRoot(options.workspaceRoot, fn)
        : fn();
    const workspace = options.workspaceRoot ?? getWorkspaceRoot();
    const exact = parseWriteCommand(task);
    const action = exact?.type ?? parseDraftLifecycleAction(task);
    const continuing = isContinueRequest(task);
    // Pre-upgrade sessions have conversation history but no durable workflow field.
    // Recover the latest real user objective only for an explicit resume/approval.
    if (
      !session.workflow &&
      !Object.prototype.hasOwnProperty.call(initialContext, "workflow") &&
      (continuing || action === "approve")
    ) {
      const prior = messages.findLast(
        (message) =>
          message.role === "user" &&
          message.content.trim() !== task.trim() &&
          !isContinueRequest(message.content) &&
          !parseWriteCommand(message.content) &&
          !parseDraftLifecycleAction(message.content),
      );
      if (prior) {
        session.workflow = newWorkflow(prior.content.trim(), workspace);
        remember(
          session.workflow,
          "Migrated the last user objective from pre-workflow conversation history. Inspect files and establish fresh verification.",
        );
      }
    }
    if (/^(?:new task|新任务)\s*[:：]/iu.test(task) && !session.pendingDraft) {
      session.workflow = null;
      task = task.replace(/^(?:new task|新任务)\s*[:：]\s*/iu, "");
    }
    if (session.workflow && session.workflow.workspace !== workspace) {
      return stop(
        "blocked",
        "任务所属目录与当前目录不同。请切回原目录，或明确开始一个新任务。",
      );
    }

    const applyDraft = async () => {
      const draft = session.pendingDraft!;
      if (session.readOnly) throw new Error("当前处于只读模式，不能写入文件。");
      if (options.signal?.aborted)
        throw new Error("请求已停止，草稿尚未写入。");
      if (session.workflow) {
        session.workflow.inFlight = `Apply approved draft ${draft.id}: ${draft.path}`;
        session.workflow.checks = {};
      }
      await checkpoint();
      const applied = await inWorkspace(() =>
        runtime.applyPendingWriteDraft(draft),
      );
      if (session.workflow) {
        if (applied?.changed) recordWrite(session.workflow, draft.path);
        else
          remember(
            session.workflow,
            `No-op draft: ${draft.path} already contained this content.`,
          );
        session.workflow.inFlight = null;
        session.workflow.status = "running";
      }
      session.pendingDraft = null;
      await checkpoint();
    };

    try {
      if (
        exact &&
        (!exact.draftId || exact.draftId !== session.pendingDraft?.id)
      )
        return finish("草稿编号缺失或已过期，请使用当前草稿的批准/取消按钮。");
      if (session.pendingDraft) {
        if (action === "cancel") {
          session.pendingDraft = null;
          return stop(
            "cancelled",
            "已丢弃草稿并停止当前任务，未应用这次改动。",
          );
        }
        // A new message does not implicitly approve an older draft.
        if (action !== "approve" && !(continuing && session.autoApprove))
          return stop(
            "awaiting_approval",
            `任务等待写入批准：${session.pendingDraft.path}\nAPPROVE_WRITE ${session.pendingDraft.id}\n或 CANCEL_WRITE ${session.pendingDraft.id}`,
          );
        await applyDraft();
        if (!session.workflow) return finish("已写入批准的草稿。"); // Legacy session compatibility.
      } else if (action === "approve" || action === "cancel") {
        if (action === "cancel" && isUnfinished(session.workflow))
          return stop("cancelled", "已停止当前任务。");
        return finish("当前没有等待批准的草稿。");
      }
      if (continuing && !isUnfinished(session.workflow))
        return finish("当前没有未完成的任务。请告诉我新的具体目标。");
      if (!isUnfinished(session.workflow))
        session.workflow = newWorkflow(task, workspace);
      else if (action !== "approve")
        remember(
          session.workflow!,
          `User follow-up (preserve original objective): ${task}`,
        );
      const state = session.workflow!;
      if (state.inFlight)
        remember(
          state,
          `Previous turn interrupted during: ${state.inFlight}. Inspect current files before retrying; do not assume success.`,
        );
      state.inFlight = null;
      state.status = "running";
      state.reason = null;
      // Checks from a previous turn may have become stale due to external edits.
      state.checks = {};
      await checkpoint();
      const prepared = await runtime.prepareConversationContext(
        runtime.getConfiguredModelName(),
        messages,
        task,
        session,
      );
      session = prepared.sessionContext;
      const context: AgentContext = {
        cleanTask: state.objective,
        model: runtime.getConfiguredModelName(),
        recentConversation: prepared.recentConversation,
        sessionContext: session,
        toolNames: listTools({ readOnly: session.readOnly === true }).map(
          (t) => t.name,
        ),
      };
      const perception = perceive(context);
      steps.push(perception.step);
      const toolRuns: ToolRun[] = [];
      let repeatedFailures = 0;
      let previousFailure = "";
      let invalidAnswers = 0;

      while (toolRuns.length < MAX_TOOL_CALLS) {
        if (options.signal?.aborted)
          return stop(
            "paused",
            "本次执行已停止，任务进度已保存。发送“继续”可恢复。",
          );
        if (Date.now() - startedAt >= MAX_RUN_MS)
          return stop(
            "paused",
            "本轮执行达到时间上限，任务尚未完成。发送“继续”可接着执行。",
          );
        context.sessionContext = session;
        const thought = await runtime.think(context, perception, toolRuns);
        if (options.signal?.aborted)
          return stop(
            "paused",
            "本次执行已停止，任务进度已保存。发送“继续”可恢复。",
          );
        steps.push(thought.step);
        await emitStepsSnapshot(steps, options.onEvent);
        if (!thought.toolName || !thought.toolInput) {
          remember(
            state,
            "Controller: An active task requires finish_task with evidence, or another tool. Plain text is not completion.",
          );
          if (++invalidAnswers >= 2)
            return stop(
              "paused",
              "模型未给出可执行的下一步，任务未完成。进度已保存，可发送“继续”重试。",
            );
          continue;
        }
        invalidAnswers = 0;
        const name = thought.toolName;
        const input = thought.toolInput;
        const args = typeof input === "string" ? {} : input;
        const toolCallId = thought.toolCallId ?? createSyntheticToolCallId();
        const assistantMessage = thought.assistantMessage ?? {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: toolCallId,
              type: "function" as const,
              function: { name, arguments: formatToolExecutionInput(input) },
            },
          ],
        };
        let result: ToolResult | undefined;
        let terminalMessage: string | null = null;
        const tool = getTool(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        state.inFlight = `${name}: ${formatToolExecutionInput(input).slice(0, 500)}`;
        await checkpoint();
        if (name === "task_plan") {
          const strings = (v: unknown): v is string[] =>
            Array.isArray(v) &&
            v.every((s) => typeof s === "string" && s.trim().length > 0);
          if (
            !["change", "inspect"].includes(String(args.kind)) ||
            !strings(args.steps) ||
            !args.steps.length ||
            !strings(args.checks) ||
            typeof args.verification_note !== "string"
          )
            result = {
              ok: false,
              content:
                "Invalid plan: provide kind, nonempty steps, checks array and verification_note string.",
            };
          else if (state.plan && state.plan.kind !== args.kind)
            result = {
              ok: false,
              content:
                "Cannot change task kind to bypass completion requirements.",
            };
          else {
            state.plan = {
              kind: args.kind as WorkflowPlan["kind"],
              steps: args.steps,
              checks: [
                ...new Set([
                  ...(state.plan?.checks ?? []),
                  ...args.checks.map((c) => c.trim()),
                ]),
              ],
              verificationNote: args.verification_note,
            };
            result = {
              ok: true,
              content: `Plan saved. Execute all steps: ${JSON.stringify(state.plan)}`,
            };
          }
        } else if (!state.plan) {
          result = {
            ok: false,
            content: "First record the full task with task_plan.",
          };
        } else if (name === "finish_task") {
          if (
            !["completed", "blocked", "needs_input", "unverified"].includes(
              String(args.status),
            ) ||
            typeof args.message !== "string" ||
            !args.message.trim()
          )
            result = {
              ok: false,
              content:
                "Specify completed, blocked, needs_input or unverified and a concrete message.",
            };
          else {
            const problem =
              args.status === "completed" || args.status === "unverified"
                ? completionProblem(
                    state,
                    !!session.pendingDraft,
                    args.status === "unverified",
                  )
                : null;
            if (problem)
              result = {
                ok: false,
                content: `Completion rejected: ${problem}`,
              };
            else {
              state.status =
                args.status === "completed"
                  ? "completed"
                  : args.status === "unverified"
                    ? "unverified"
                    : "blocked";
              state.reason = state.status === "completed" ? null : args.message;
              terminalMessage = args.message;
              if (state.status === "unverified")
                terminalMessage = `改动已完成，但验收尚未完成。\n${args.message}`;
              result = { ok: true, content: `Task ${state.status}.` };
            }
          }
        }
        let toolRun: ToolRun;
        if (result)
          toolRun = {
            name,
            input,
            inputText: formatToolExecutionInput(input),
            result,
            tool,
            toolCallId,
            assistantMessage,
          };
        else {
          toolRun = await inWorkspace(() =>
            runtime.runToolCall(name, input, toolCallId, assistantMessage, {
              readOnly: session.readOnly === true,
              signal: options.signal,
            }),
          );
          session = buildNextSessionContext(session, [toolRun]);
          if (
            toolRun.result.draft &&
            session.autoApprove &&
            !session.readOnly
          ) {
            await applyDraft();
            toolRun.result = {
              ok: true,
              content: `Applied to disk: ${toolRun.result.draft.path}. Continue the task and verify after all edits.`,
            };
          }
          if (toolRun.result.command) {
            const command = toolRun.result.command;
            if (
              command.verification &&
              state.plan &&
              !state.plan.checks.includes(command.text)
            )
              state.plan.checks.push(command.text);
            state.checks[command.text] = {
              revision: state.revision,
              ok: toolRun.result.ok && command.exitCode === 0,
            };
          }
        }
        toolRuns.push(toolRun);
        state.inFlight = null;
        remember(
          state,
          `${name} ${toolRun.inputText.slice(0, 400)}\n${toolRun.result.ok ? "OK" : "FAILED"}: ${toolRun.result.content}`,
        );
        steps.push(
          createStep(
            `act-${toolRuns.length}`,
            "Act",
            `${name}: ${toolRun.result.ok ? "ok" : "failed"}`,
          ),
        );
        await checkpoint();
        await options.onToolRun?.(toolRun);
        if (terminalMessage) return finish(terminalMessage);
        if (session.pendingDraft)
          return stop("awaiting_approval", toolRun.result.content);
        const fingerprint = `${name}:${toolRun.inputText}`;
        repeatedFailures = !toolRun.result.ok
          ? previousFailure === fingerprint
            ? repeatedFailures + 1
            : 1
          : 0;
        previousFailure = toolRun.result.ok ? "" : fingerprint;
        if (repeatedFailures >= 3)
          return stop(
            "blocked",
            `相同操作连续失败三次，已停止重复执行。任务尚未完成。\n${toolRun.result.content}`,
          );
      }
      return stop(
        "paused",
        `本轮已执行 ${MAX_TOOL_CALLS} 次操作，任务尚未完成。原目标、已改文件和检查结果已保存；发送“继续”可恢复。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return stop(
        "paused",
        `执行中断，任务尚未完成，进度已保存。\n${message}\n发送“继续”可恢复。`,
      );
    }
  };
  return (...args: Parameters<typeof run>) =>
    withExecutionSignal(args[4]?.signal, () => run(...args));
}

export const runAgent = createAgentRunner();
