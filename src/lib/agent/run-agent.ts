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
} from "@/lib/agent/conversation-context";
import { getConfiguredModelName } from "@/lib/agent/model-client";
import {
  createMessage,
  createStep,
  emitStepsSnapshot,
  finishAgentRun,
  type RunAgentOptions,
} from "@/lib/agent/agent-response";
import { formatToolExecutionInput } from "@/lib/agent/tool-args";
import {
  APPROVE_WRITE_COMMAND,
  CANCEL_WRITE_COMMAND,
  MAX_TOOL_CALLS,
  createSyntheticToolCallId,
  type ToolRun,
} from "@/lib/agent/tool-run-types";
import { buildNextSessionContext } from "@/lib/agent/session-state";
import {
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
            `Or simply reply: approve / 鎵瑰噯`,
            `If you want to discard it, say: ${CANCEL_WRITE_COMMAND} ${effectiveSessionContext.pendingDraft.id}`,
            `Or simply reply: cancel / 鍙栨秷`,
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

  const toolRuns: ToolRun[] = [];

  while (true) {
    const roundNumber = toolRuns.length + 1;
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
          sessionContext: buildNextSessionContext(context.sessionContext, toolRuns),
          steps,
        },
        false,
        toolRuns.length,
      );
    }

    if (toolRuns.length >= MAX_TOOL_CALLS) {
      const finalReply = await answerWithToolResults(
        context,
        perception.goal,
        toolRuns,
      );

      await replaceLastStep(
        createStep(
          `act-${roundNumber}`,
          "Act",
          `Run tool call ${toolRuns.length} with "${toolRun.name}" and stop there because the tool budget is exhausted. Use all collected tool results to produce the final answer.`,
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
