import type {
  AgentResponse,
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";
import { createLogger } from "@/lib/logger";
import { listTools } from "@/lib/tools/tool-registry";
import { withWorkspaceRoot } from "@/lib/tools/workspace-path";
import {
  normalizeSessionContext,
  prepareConversationContext,
  formatConversationForModel,
  formatConversationSummaryForModel,
} from "@/lib/agent/conversation-context";
import {
  callModelForText,
  getConfiguredModelName,
} from "@/lib/agent/model-client";
import {
  createMessage,
  createStep,
  emitStepsSnapshot,
  finishAgentRun,
  type RunAgentOptions,
} from "@/lib/agent/agent-response";
import {
  formatToolExecutionInput,
  formatToolRunsForModel,
} from "@/lib/agent/tool-args";
import {
  APPROVE_WRITE_COMMAND,
  CANCEL_WRITE_COMMAND,
  createSyntheticToolCallId,
  getEffectiveMaxToolCalls,
  type ToolRun,
} from "@/lib/agent/tool-run-types";
import {
  buildNextSessionContext,
  formatSessionContextForModel,
} from "@/lib/agent/session-state";
import {
  handleAutoWriteApproval,
  handleWriteApproval,
  isAmbiguousDraftConfirmation,
  parseDraftLifecycleAction,
  parseWriteCommand,
} from "@/lib/agent/draft-lifecycle";
import { runToolCall } from "@/lib/agent/tool-runner";
import {
  answerDirectly,
  answerWithToolResults,
  isFileModificationRequest,
  perceive,
  think,
  thinkStrategies,
  type AgentContext,
} from "@/lib/agent/agent-thinking";
import {
  planTask,
  runSubtask,
  shouldDecomposeTask,
} from "@/lib/agent/task-planner";
import {
  createSubtasks,
  listSubtasksForParentTask,
  updateSubtaskStatus,
  type SubtaskRecord,
} from "@/lib/db/store";

type TaskCompletionJudgment = {
  done: boolean;
  reason: string;
};

function parseTaskCompletionJudgment(content: string): TaskCompletionJudgment {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;

  try {
    const parsed = JSON.parse(jsonText) as {
      done?: unknown;
      reason?: unknown;
    };

    return {
      done: parsed.done === true,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim()
          : "The completion judge did not include a reason.",
    };
  } catch {
    return {
      done: false,
      reason: "The completion judge did not return valid JSON.",
    };
  }
}

async function judgeTaskCompletion(
  context: AgentContext,
  goal: string,
  toolRuns: ToolRun[],
): Promise<TaskCompletionJudgment> {
  const response = await callModelForText(context.model, [
    {
      role: "system",
      content: [
        "You are the completion judge for a stripped-down coding agent.",
        "Decide whether the original user task is complete using only the completed tool results and session context.",
        "Return only valid JSON with this exact shape: {\"done\": boolean, \"reason\": string}.",
        "Use done=true only when the user can receive a final answer now without another tool call.",
        "Use done=false if another tool call is still needed, if a tool failed and recovery is possible, or if the gathered information is not enough.",
        "If the user asked to modify files, the task is not complete after only reading files.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Older conversation summary:",
        formatConversationSummaryForModel(context.sessionContext),
        "",
        "Recent conversation:",
        formatConversationForModel(context.recentConversation),
        "",
        "Session reference hints:",
        formatSessionContextForModel(context.sessionContext),
        "",
        `Original task: ${goal}`,
        "",
        "Completed tool results:",
        formatToolRunsForModel(toolRuns),
      ].join("\n"),
    },
  ]);

  return parseTaskCompletionJudgment(response.content);
}

function createReadOnlyBlockedResponse(
  sessionContext: AgentSessionContext,
): AgentResponse {
  return {
    message: createMessage(
      [
        "Current session is read-only, so I cannot modify files.",
        "",
        "Exit read-only mode before asking me to write, replace, create, or delete files.",
      ].join("\n"),
    ),
    sessionContext,
    steps: [
      createStep(
        "perceive",
        "Perceive",
        "Read a request that would modify files while this session is read-only.",
      ),
      createStep(
        "think",
        "Think",
        "Read-only mode disables write_file and replace_text for this session.",
      ),
      createStep(
        "act",
        "Act",
        "Stop before modifying files and tell the user how to continue.",
      ),
    ],
  };
}

function summarizeSubtaskResult(content: string | null | undefined) {
  const cleanContent = content?.trim();

  if (!cleanContent) {
    return "No result text was recorded.";
  }

  return cleanContent.length > 500
    ? `${cleanContent.slice(0, 500).trim()}...`
    : cleanContent;
}

function createSubtaskSummary(subtasks: SubtaskRecord[]) {
  return subtasks
    .map(
      (subtask, index) =>
        `${index + 1}. [${subtask.status}] ${subtask.description}\n${summarizeSubtaskResult(subtask.result)}`,
    )
    .join("\n\n");
}

async function runTaskPlanFlow(input: {
  context: AgentContext;
  goal: string;
  pushStep: (step: AgentStep) => Promise<void>;
  sessionId: string;
  steps: AgentStep[];
}) {
  let subtasks = listSubtasksForParentTask({
    parentTask: input.goal,
    sessionId: input.sessionId,
  });

  if (subtasks.length === 0) {
    const descriptions = await planTask(input.goal, input.context);
    subtasks = createSubtasks({
      descriptions,
      parentTask: input.goal,
      sessionId: input.sessionId,
    });

    await input.pushStep(
      createStep(
        "think-task-plan",
        "Think",
        `Split the task into ${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}.`,
      ),
    );
  } else {
    await input.pushStep(
      createStep(
        "think-task-plan",
        "Think",
        `Resume ${subtasks.length} existing subtask${subtasks.length === 1 ? "" : "s"} for this parent task. Completed subtasks will not be rerun.`,
      ),
    );
  }

  let currentSessionContext = input.context.sessionContext;
  const completedSubtasks: SubtaskRecord[] = [];

  for (const subtask of subtasks) {
    if (subtask.status === "done") {
      completedSubtasks.push(subtask);
      continue;
    }

    let attempts = 0;
    let finishedSubtask: SubtaskRecord | null = null;

    while (!finishedSubtask && attempts < 2) {
      attempts += 1;
      updateSubtaskStatus({
        id: subtask.id,
        result: subtask.result,
        status: "running",
      });
      await input.pushStep(
        createStep(
          `act-subtask-${subtask.id}-${attempts}`,
          "Act",
          attempts === 1
            ? `Run subtask: ${subtask.description}`
            : `Retry only the failed subtask: ${subtask.description}`,
        ),
      );

      try {
        const result = await runSubtask(subtask, currentSessionContext);
        currentSessionContext = result.sessionContext;

        if (
          result.sessionContext.pendingDraft &&
          result.sessionContext.autoApprove !== true
        ) {
          updateSubtaskStatus({
            id: subtask.id,
            result: result.message.content,
            status: "running",
          });

          await input.pushStep(
            createStep(
              `act-subtask-${subtask.id}-waiting`,
              "Act",
              "Pause the task plan because this subtask created a pending write draft that still needs approval.",
            ),
          );

          return {
            message: result.message,
            sessionContext: result.sessionContext,
            steps: input.steps,
          };
        }

        updateSubtaskStatus({
          id: subtask.id,
          result: result.message.content,
          status: "done",
        });
        finishedSubtask = {
          ...subtask,
          result: result.message.content,
          status: "done",
        };
        completedSubtasks.push(finishedSubtask);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Subtask failed.";
        updateSubtaskStatus({
          id: subtask.id,
          result: errorMessage,
          status: "failed",
        });

        if (attempts >= 2) {
          await input.pushStep(
            createStep(
              `act-subtask-${subtask.id}-failed`,
              "Act",
              `Stop after retrying the failed subtask. Error: ${errorMessage}`,
            ),
          );

          return {
            message: createMessage(
              [
                "Task planning stopped because one subtask failed after retry.",
                "",
                `Failed subtask: ${subtask.description}`,
                `Error: ${errorMessage}`,
                "",
                "Completed subtasks:",
                createSubtaskSummary(completedSubtasks),
              ].join("\n"),
            ),
            sessionContext: currentSessionContext,
            steps: input.steps,
          };
        }
      }
    }
  }

  const latestSubtasks = listSubtasksForParentTask({
    parentTask: input.goal,
    sessionId: input.sessionId,
  });

  await input.pushStep(
    createStep(
      "act-task-plan-complete",
      "Act",
      "All subtasks are done. Return the combined task result.",
    ),
  );

  return {
    message: createMessage(
      [
        "Task plan complete.",
        "",
        createSubtaskSummary(latestSubtasks),
      ].join("\n"),
    ),
    sessionContext: currentSessionContext,
    steps: input.steps,
  };
}

export async function runAgent(
  task: string,
  messages: ChatMessage[] = [],
  sessionContext: AgentSessionContext = {},
  requestId: string,
  options: RunAgentOptions = {},
): Promise<AgentResponse> {
  const onEvent = options.onEvent;
  const onToolRun = options.onToolRun;
  const finish = async (response: AgentResponse, includeSteps: boolean) =>
    finishAgentRun(response, onEvent, includeSteps);
  const logger = createLogger(requestId);
  const startedAt = Date.now();
  let loopFinishedLogged = false;
  const finishWithLogging = async (
    response: AgentResponse,
    includeSteps: boolean,
    totalIterations: number,
  ) => {
    if (!loopFinishedLogged) {
      loopFinishedLogged = true;
      logger.info("agent loop finished", {
        totalIterations,
        durationMs: Date.now() - startedAt,
      });
    }

    return finish(response, includeSteps);
  };

  const normalizedSessionContext = normalizeSessionContext(sessionContext);
  const effectiveSessionContext: AgentSessionContext = {
    ...normalizedSessionContext,
    autoApprove: normalizedSessionContext.autoApprove === true,
    maxToolCalls: normalizedSessionContext.maxToolCalls,
    pendingDraft: normalizedSessionContext.pendingDraft ?? null,
    projectId: options.projectId ?? normalizedSessionContext.projectId ?? null,
    readOnly: normalizedSessionContext.readOnly === true,
    sessionId: options.sessionId ?? normalizedSessionContext.sessionId ?? null,
  };
  const exactWriteCommand = parseWriteCommand(task);
  const draftLifecycleAction = exactWriteCommand
    ? null
    : parseDraftLifecycleAction(task);

  if (
    effectiveSessionContext.readOnly &&
    exactWriteCommand?.type === "approve" &&
    effectiveSessionContext.pendingDraft
  ) {
    return finishWithLogging(
      createReadOnlyBlockedResponse(effectiveSessionContext),
      true,
      0,
    );
  }

  const writeApprovalResult = await handleWriteApproval(
    task,
    effectiveSessionContext.pendingDraft ?? null,
  );
  if (writeApprovalResult) {
    return finishWithLogging(
      {
        ...writeApprovalResult,
        sessionContext: {
          ...effectiveSessionContext,
          ...writeApprovalResult.sessionContext,
        },
      },
      true,
      0,
    );
  }

  if (!draftLifecycleAction) {
    const autoApprovalResult = await handleAutoWriteApproval(
      effectiveSessionContext,
      effectiveSessionContext.pendingDraft ?? null,
    );

    if (autoApprovalResult) {
      return finishWithLogging(autoApprovalResult, true, 0);
    }
  }

  if (draftLifecycleAction && !effectiveSessionContext.pendingDraft) {
    return finishWithLogging(
      {
        message: createMessage(
          [
            "There is no pending draft right now.",
            "The last draft has already been approved or discarded.",
            "If you want another change, tell me to edit the real file or create a new draft.",
          ].join("\n"),
        ),
        sessionContext: effectiveSessionContext,
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read a draft lifecycle request from the user.",
          ),
          createStep(
            "think",
            "Think",
            "Check whether a real pending draft still exists on the backend.",
          ),
          createStep(
            "act",
            "Act",
            "Stop here because there is no active draft left to approve, cancel, or continue.",
          ),
        ],
      },
      true,
      0,
    );
  }

  if (
    effectiveSessionContext.pendingDraft &&
    !draftLifecycleAction &&
    isAmbiguousDraftConfirmation(task)
  ) {
    return finishWithLogging(
      {
        message: createMessage(
          [
            "I found a pending draft, but your confirmation word was too vague.",
            `Draft id: ${effectiveSessionContext.pendingDraft.id}`,
            `Target path: ${effectiveSessionContext.pendingDraft.path}`,
            `If you want to write it, say: ${APPROVE_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
            `Or simply reply: approve / 批准`,
            `If you want to discard it, say: ${CANCEL_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
            `Or simply reply: cancel / 取消`,
          ].join("\n"),
        ),
        sessionContext: effectiveSessionContext,
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read a short confirmation reply while a draft is still pending.",
          ),
          createStep(
            "think",
            "Think",
            "Decide whether the confirmation is explicit enough to approve or cancel safely.",
          ),
          createStep(
            "act",
            "Act",
            "Do not start a new task. Ask the user for an explicit approve or cancel instruction for the pending draft.",
          ),
        ],
      },
      true,
      0,
    );
  }

  if (
    draftLifecycleAction === "approve" &&
    effectiveSessionContext.pendingDraft
  ) {
    if (effectiveSessionContext.readOnly) {
      return finishWithLogging(
        createReadOnlyBlockedResponse(effectiveSessionContext),
        true,
        0,
      );
    }

    const approvalResult = await handleWriteApproval(
      `${APPROVE_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
      effectiveSessionContext.pendingDraft,
    );

    if (!approvalResult) {
      throw new Error("Expected a pending draft approval result.");
    }

    return finishWithLogging(
      {
        ...approvalResult,
        sessionContext: {
          ...effectiveSessionContext,
          ...approvalResult.sessionContext,
        },
      },
      true,
      0,
    );
  }

  if (
    draftLifecycleAction === "cancel" &&
    effectiveSessionContext.pendingDraft
  ) {
    const cancelResult = await handleWriteApproval(
      `${CANCEL_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
      effectiveSessionContext.pendingDraft,
    );

    if (!cancelResult) {
      throw new Error("Expected a pending draft cancel result.");
    }

    return finishWithLogging(
      {
        ...cancelResult,
        sessionContext: {
          ...effectiveSessionContext,
          ...cancelResult.sessionContext,
        },
      },
      true,
      0,
    );
  }

  if (
    draftLifecycleAction === "continue" &&
    effectiveSessionContext.pendingDraft
  ) {
    return finishWithLogging(
      {
        message: createMessage(
          [
            "The last step is waiting on a draft decision.",
            `Draft id: ${effectiveSessionContext.pendingDraft.id}`,
            `Target path: ${effectiveSessionContext.pendingDraft.path}`,
            `To finish the write, send: ${APPROVE_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
            `To discard it, send: ${CANCEL_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
            "If you want to change the draft first, tell me what to edit in that draft.",
          ].join("\n"),
        ),
        sessionContext: effectiveSessionContext,
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read a continue request from the user while a draft is still pending.",
          ),
          createStep(
            "think",
            "Think",
            "Match the continue request to the current pending draft and keep the explicit approval gate.",
          ),
          createStep(
            "act",
            "Act",
            "Return the exact next command to approve or cancel the pending draft, or invite the user to edit that draft first.",
          ),
        ],
      },
      true,
      0,
    );
  }

  if (
    effectiveSessionContext.readOnly &&
    isFileModificationRequest(task)
  ) {
    return finishWithLogging(
      createReadOnlyBlockedResponse(effectiveSessionContext),
      true,
      0,
    );
  }

  const model = getConfiguredModelName();
  const preparedConversationContext = await prepareConversationContext(
    model,
    messages,
    task,
    effectiveSessionContext,
  );
  const context: AgentContext = {
    cleanTask: task.trim(),
    model,
    recentConversation: preparedConversationContext.recentConversation,
    sessionContext: preparedConversationContext.sessionContext,
    toolNames: listTools({
      readOnly: preparedConversationContext.sessionContext.readOnly === true,
    }).map((tool) => tool.name),
  };

  const steps: AgentStep[] = [];
  const pushStep = async (step: AgentStep) => {
    steps.push(step);
    await emitStepsSnapshot(steps, onEvent);
  };
  const replaceLastStep = async (step: AgentStep) => {
    steps[steps.length - 1] = step;
    await emitStepsSnapshot(steps, onEvent);
  };

  const perception = perceive(context);
  await pushStep(perception.step);

  if (!options.disableTaskPlanning && context.sessionContext.sessionId) {
    const decomposition = await shouldDecomposeTask(perception.goal, context);
    await pushStep(
      createStep(
        "think-decomposition",
        "Think",
        `Task decomposition check: ${decomposition.split ? "split" : "do not split"}. Reason: ${decomposition.reason}`,
      ),
    );

    if (decomposition.split) {
      const taskPlanResponse = await runTaskPlanFlow({
        context,
        goal: perception.goal,
        pushStep,
        sessionId: context.sessionContext.sessionId,
        steps,
      });

      return finishWithLogging(taskPlanResponse, false, 0);
    }
  }

  const toolRuns: ToolRun[] = [];

  while (true) {
    const roundNumber = toolRuns.length + 1;
    const maxToolCalls = getEffectiveMaxToolCalls(context.sessionContext);
    logger.info("agent loop iteration start", { loopCount: roundNumber });
    const strategy = thinkStrategies.find((strategy) =>
      strategy.match(toolRuns, perception.goal),
    );
    const thought = strategy
      ? await strategy.think({ context, perception, roundNumber, toolRuns })
      : await think(context, perception, toolRuns);

    await pushStep(thought.step);

    if (!thought.toolName || !thought.toolInput) {
      const reply =
        toolRuns.length === 0
          ? thought.directAnswer
            ? {
                content: thought.directAnswer,
                reasoning_content:
                  thought.assistantMessage?.reasoning_content ?? null,
              }
            : await answerDirectly(context, perception.goal)
          : thought.directAnswer
            ? {
                content: thought.directAnswer,
                reasoning_content:
                  thought.assistantMessage?.reasoning_content ?? null,
              }
            : await answerWithToolResults(context, perception.goal, toolRuns);

      await pushStep(
        createStep(
          `act-${roundNumber}`,
          "Act",
          toolRuns.length === 0
            ? thought.directAnswer
              ? "Return the model's direct answer without using a tool."
              : `Call model "${context.model}" and return one assistant message to the chat UI.`
            : thought.directAnswer
              ? `Return the model's final answer after reviewing ${toolRuns.length} tool result${toolRuns.length === 1 ? "" : "s"}.`
              : `Use the ${toolRuns.length} completed tool result${toolRuns.length === 1 ? "" : "s"} to build a final answer because the planning reply did not request another tool.`,
        ),
      );

      return finishWithLogging(
        {
          message: createMessage(reply.content, reply.reasoning_content),
          sessionContext:
            toolRuns.length === 0
              ? context.sessionContext
              : buildNextSessionContext(context.sessionContext, toolRuns),
          steps,
        },
        false,
        toolRuns.length,
      );
    }

    logger.info("tool call dispatched", { toolName: thought.toolName });

    let toolRun: ToolRun;
    try {
      const toolName = thought.toolName;
      const toolInput = thought.toolInput;
      const toolCallId = thought.toolCallId ?? createSyntheticToolCallId();
      const runCurrentTool = () =>
        runToolCall(
          toolName,
          toolInput,
          toolCallId,
          thought.assistantMessage ?? {
            role: "assistant",
            content: "",
            reasoning_content: "",
            tool_calls: [
              {
                id: toolCallId,
                type: "function",
                function: {
                  name: toolName,
                  arguments: formatToolExecutionInput(toolInput),
                },
              },
            ],
          },
          {
            readOnly: context.sessionContext.readOnly === true,
          },
        );

      toolRun = options.workspaceRoot
        ? await withWorkspaceRoot(options.workspaceRoot, runCurrentTool)
        : await runCurrentTool();
      logger.info("tool call completed", {
        toolName: thought.toolName,
        succeeded: toolRun.result.ok,
      });
    } catch (error) {
      logger.info("tool call completed", {
        toolName: thought.toolName,
        succeeded: false,
      });
      throw error;
    }

    toolRuns.push(toolRun);
    await onToolRun?.(toolRun);

    await pushStep(
      createStep(
        `act-${roundNumber}`,
        "Act",
        `Run tool call ${toolRuns.length} with "${toolRun.name}" using input ${toolRun.inputText} and capture the result for the next decision.`,
      ),
    );

    const immediateOutcome = toolRun.tool.onResult?.(
      perception.goal,
      toolRun.result,
      toolRuns,
    );
    if (immediateOutcome?.type === "immediate") {
      const nextSessionContext = buildNextSessionContext(
        context.sessionContext,
        toolRuns,
      );
      const autoApprovalResult = await handleAutoWriteApproval(
        nextSessionContext,
        toolRun.result.draft ?? null,
      );

      if (autoApprovalResult) {
        return finishWithLogging(autoApprovalResult, true, toolRuns.length);
      }

      await replaceLastStep(
        createStep(
          `act-${roundNumber}`,
          "Act",
          `Run "${toolRun.name}" and return its immediate tool result directly.`,
        ),
      );

      return finishWithLogging(
        {
          message: createMessage(immediateOutcome.message),
          sessionContext: nextSessionContext,
          steps,
        },
        false,
        toolRuns.length,
      );
    }

    const completionJudgment = await judgeTaskCompletion(
      context,
      perception.goal,
      toolRuns,
    );
    await pushStep(
      createStep(
        `think-completion-${roundNumber}`,
        "Think",
        `Completion check after ${toolRuns.length} tool call${toolRuns.length === 1 ? "" : "s"}: ${completionJudgment.done ? "done" : "continue"}. Reason: ${completionJudgment.reason}`,
      ),
    );

    if (completionJudgment.done) {
      const finalReply = await answerWithToolResults(
        context,
        perception.goal,
        toolRuns,
      );

      await pushStep(
        createStep(
          `act-final-${roundNumber}`,
          "Act",
          "Return the final answer because the completion judge marked the task as done.",
        ),
      );

      return finishWithLogging(
        {
          message: createMessage(finalReply.content, finalReply.reasoning_content),
          sessionContext: buildNextSessionContext(context.sessionContext, toolRuns),
          steps,
        },
        false,
        toolRuns.length,
      );
    }

    if (toolRuns.length >= maxToolCalls) {
      const finalReply = await answerWithToolResults(
        context,
        perception.goal,
        toolRuns,
      );

      await replaceLastStep(
        createStep(
          `act-${roundNumber}`,
          "Act",
          `Run tool call ${toolRuns.length} with "${toolRun.name}" and stop there because the safety tool budget of ${maxToolCalls} is exhausted. Use all collected tool results to produce the final answer.`,
        ),
      );

      return finishWithLogging(
        {
          message: createMessage(finalReply.content, finalReply.reasoning_content),
          sessionContext: buildNextSessionContext(context.sessionContext, toolRuns),
          steps,
        },
        false,
        toolRuns.length,
      );
    }
  }
}
