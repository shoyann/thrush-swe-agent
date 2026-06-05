import type {
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";
import { listTools } from "@/lib/tools/tool-registry";
import type {
  ToolCallArgs,
  ToolExecutionInput,
} from "@/lib/tools/types";
import {
  formatConversationForModel,
  formatConversationSummaryForModel,
} from "@/lib/agent/conversation-context";
import {
  callModelForText,
  callModelForToolDecision,
  type LlmMessage,
} from "@/lib/agent/model-client";
import { createStep } from "@/lib/agent/agent-response";
import {
  getNumberArg,
  getStringArg,
  getStringArrayArg,
  formatToolExecutionInput,
  formatToolRunsForModel,
} from "@/lib/agent/tool-args";
import {
  getEffectiveMaxToolCalls,
  type ToolRun,
} from "@/lib/agent/tool-run-types";
import { formatSessionContextForModel } from "@/lib/agent/session-state";
import {
  deriveIssueInvestigationToolCallFromToolRun,
  deriveIssuePlanToolCallFromToolRun,
  getLatestIssuePlanText,
  isIssueDrivenReadForDraft,
} from "@/lib/agent/issue-flow";
import {
  deriveDirectToolPlan,
  deriveFocusedWebSearchQuery,
  deriveWebSearchQueryFromTask,
} from "@/lib/agent/direct-tool-plans";
import {
  buildAnswerDirectlySystemPrompt,
  buildAnswerWithToolResultsSystemPrompt,
  buildFileModificationSystemPrompt,
  buildPlannerSystemPrompt,
} from "./prompts";
import { isFileModificationRequest as isFileModificationIntent } from "@/lib/agent/intent";

export type AgentContext = {
  cleanTask: string;
  recentConversation: ChatMessage[];
  sessionContext: AgentSessionContext;
  model: string;
  toolNames: string[];
};

export type PerceptionResult = {
  goal: string;
  taskSize: string;
  step: AgentStep;
};

export type ThoughtResult = {
  assistantMessage: LlmMessage | null;
  directAnswer: string | null;
  nextAction: string;
  plan: string[];
  step: AgentStep;
  toolCallId: string | null;
  toolInput: ToolExecutionInput | null;
  toolName: string | null;
};

type ThinkStrategyContext = {
  context: AgentContext;
  perception: PerceptionResult;
  roundNumber: number;
  toolRuns: ToolRun[];
};

type ThinkStrategy = {
  match: (toolRuns: ToolRun[], goal: string) => boolean;
  think: (context: ThinkStrategyContext) => Promise<ThoughtResult> | ThoughtResult;
};

function getRemainingToolCalls(context: AgentContext, toolRuns: ToolRun[]) {
  return Math.max(getEffectiveMaxToolCalls(context.sessionContext) - toolRuns.length, 0);
}

function buildThoughtPlan(toolRuns: ToolRun[], remainingToolCalls: number) {
  if (toolRuns.length === 0) {
    return [
      "Understand what the user wants.",
      "Ask the model whether it needs a tool.",
      "Use the safest next action.",
    ];
  }

  if (remainingToolCalls > 0) {
    return [
      "Review the latest tool result.",
      "Decide whether another tool is still needed.",
      "Answer now if the task is already complete.",
    ];
  }

  return [
    "Review the completed tool results.",
    "Stop using tools.",
    "Turn the results into a final answer.",
  ];
}

function normalizeToolInput(toolName: string, rawInput: ToolCallArgs, task: string) {
  if (toolName === "list_files") {
    return {
      path: getStringArg(rawInput, "path") || ".",
    };
  }

  if (toolName === "read_file") {
    const path = getStringArg(rawInput, "path");

    if (!path) {
      return null;
    }

    const startLine = getNumberArg(rawInput, "start_line");
    const maxLines = getNumberArg(rawInput, "max_lines");

    return {
      path,
      ...(startLine === null ? {} : { start_line: startLine }),
      ...(maxLines === null ? {} : { max_lines: maxLines }),
    };
  }

  if (toolName === "read_page") {
    const url = getStringArg(rawInput, "url");
    const maxChars = getNumberArg(rawInput, "max_chars");

    if (!url) {
      return null;
    }

    return maxChars === null ? { url } : { url, max_chars: maxChars };
  }

  if (toolName === "click_page") {
    const url = getStringArg(rawInput, "url");
    const selector = getStringArg(rawInput, "selector");
    const maxChars = getNumberArg(rawInput, "max_chars");

    if (!url || !selector) {
      return null;
    }

    return maxChars === null
      ? { url, selector }
      : { url, selector, max_chars: maxChars };
  }

  if (toolName === "write_file") {
    const path = getStringArg(rawInput, "path");
    const contentValue = rawInput.content;
    const content = typeof contentValue === "string" ? contentValue : null;

    if (!path || content === null) {
      return null;
    }

    return {
      path,
      content,
    };
  }

  if (toolName === "replace_text") {
    const path = getStringArg(rawInput, "path");
    const oldTextValue = rawInput.old_text;
    const newTextValue = rawInput.new_text;
    const oldText = typeof oldTextValue === "string" ? oldTextValue : null;
    const newText = typeof newTextValue === "string" ? newTextValue : null;

    if (!path || oldText === null || oldText.length === 0 || newText === null) {
      return null;
    }

    return {
      path,
      old_text: oldText,
      new_text: newText,
    };
  }

  if (toolName === "search_text") {
    const query = getStringArg(rawInput, "query");
    const path = getStringArg(rawInput, "path");

    if (!query) {
      return null;
    }

    return path ? { query, path } : { query };
  }

  if (toolName === "safe_command") {
    const command = getStringArg(rawInput, "command").toLowerCase();
    const args = getStringArrayArg(rawInput, "args");

    if (!command || args.length === 0) {
      return null;
    }

    return {
      command,
      args,
    };
  }

  if (toolName === "web_search") {
    const query = getStringArg(rawInput, "query");

    return {
      query: deriveFocusedWebSearchQuery(deriveWebSearchQueryFromTask(query || task)),
    };
  }

  return rawInput;
}

export function perceive(context: AgentContext): PerceptionResult {
  const wordCount = context.cleanTask.split(/\s+/).filter(Boolean).length;
  const taskSize = wordCount <= 6 ? "small" : "multi-part";

  return {
    goal: context.cleanTask,
    taskSize,
    step: createStep(
      "perceive",
      "Perceive",
      `Read the task, clean the input, and identify the goal: "${context.cleanTask}". The task looks ${taskSize}. Recent conversation messages available: ${context.recentConversation.length}. Reference hints available: ${context.sessionContext.pendingDraft ? "pending draft" : "no pending draft"}.`,
    ),
  };
}

function buildMessagesWithToolRuns(baseMessages: LlmMessage[], toolRuns: ToolRun[]) {
  const toolMessages = toolRuns.flatMap((toolRun) => [
    toolRun.assistantMessage,
    {
      role: "tool" as const,
      tool_call_id: toolRun.toolCallId,
      content: toolRun.result.content,
    },
  ]);

  return [...baseMessages, ...toolMessages];
}

export function isFileModificationRequest(task: string) {
  return isFileModificationIntent(task);
}

export async function think(
  context: AgentContext,
  perception: PerceptionResult,
  toolRuns: ToolRun[],
): Promise<ThoughtResult> {
  const readOnly = context.sessionContext.readOnly === true;
  const availableTools = listTools({ readOnly });
  const roundNumber = toolRuns.length + 1;
  const maxToolCalls = getEffectiveMaxToolCalls(context.sessionContext);
  const remainingToolCalls = getRemainingToolCalls(context, toolRuns);
  const plan = buildThoughtPlan(toolRuns, remainingToolCalls);

  const toolList = availableTools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description} Input form: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join("\n");

  const directToolPlan =
    toolRuns.length === 0 ? deriveDirectToolPlan(perception.goal) : null;

  if (directToolPlan) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction: `Use ${directToolPlan.name} with input ${formatToolExecutionInput(directToolPlan.input)}.`,
      plan,
      toolCallId: directToolPlan.id,
      toolName: directToolPlan.name,
      toolInput: directToolPlan.input,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: Use ${directToolPlan.name} with input ${formatToolExecutionInput(directToolPlan.input)}.`,
      ),
    };
  }

  const plannerReply = await callModelForToolDecision(
    context.model,
    buildMessagesWithToolRuns(
      [
        {
          role: "system",
          content: buildPlannerSystemPrompt({
            maxToolCalls,
            readOnly,
            remainingToolCalls,
            toolList,
            toolRunCount: toolRuns.length,
          }),
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
            `Original task: ${perception.goal}`,
            `Tool calls already used: ${toolRuns.length}`,
            `Tool calls remaining: ${remainingToolCalls}`,
          ].join("\n"),
        },
      ],
      toolRuns,
    ),
    context.toolNames,
  );

  const normalizedToolInput = plannerReply.toolCall
    ? normalizeToolInput(
        plannerReply.toolCall.name,
        plannerReply.toolCall.input,
        perception.goal,
      )
    : null;
  const plannedToolCall =
    plannerReply.toolCall && normalizedToolInput
      ? {
          id: plannerReply.toolCall.id,
          name: plannerReply.toolCall.name,
          input: normalizedToolInput,
        }
      : null;
  const chosenToolInput = plannedToolCall?.input ?? null;
  const directAnswer = plannerReply.content;

  const nextAction = plannedToolCall
    ? `Use ${plannedToolCall.name} with input ${formatToolExecutionInput(chosenToolInput ?? plannedToolCall.input)}.`
    : directAnswer
      ? "Return the model's direct answer."
      : "Fallback to a direct model answer because the tool decision was invalid.";

  return {
    assistantMessage: plannerReply.assistantMessage,
    directAnswer,
    nextAction,
    plan,
    toolCallId: plannedToolCall?.id ?? null,
    toolName: plannedToolCall?.name ?? null,
    toolInput: chosenToolInput,
    step: createStep(
      `think-${roundNumber}`,
      "Think",
      `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: ${nextAction}`,
    ),
  };
}

export async function forceEditWithToolResults(
  context: AgentContext,
  goal: string,
  toolRuns: ToolRun[],
  roundNumber: number,
): Promise<ThoughtResult> {
  if (context.sessionContext.readOnly) {
    return {
      assistantMessage: null,
      directAnswer:
        "Current session is read-only, so I cannot prepare a file modification draft.",
      nextAction: "Return a read-only mode refusal instead of preparing a write draft.",
      plan: [
        "Review the collected file context.",
        "Notice that this session is read-only.",
        "Stop before preparing a write draft.",
      ],
      toolCallId: null,
      toolName: null,
      toolInput: null,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        "Force-edit check stopped because this session is read-only.",
      ),
    };
  }

  const reply = await callModelForToolDecision(
    context.model,
    buildMessagesWithToolRuns(
      [
        {
          role: "system",
          content: [
            "The user asked for a code modification or bug fix.",
            "You already have file/tool evidence in the conversation history.",
            "If the exact edit is supported by that evidence, call exactly one tool: replace_text or write_file.",
            "Do not provide manual editing instructions when a safe file draft can be prepared.",
            "If there is not enough evidence to edit safely, answer briefly with the missing evidence and do not claim files changed.",
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
            "Use the completed tool results below to prepare one concrete file edit if possible.",
          ].join("\n"),
        },
      ],
      toolRuns,
    ),
    ["replace_text", "write_file"],
  );

  const normalizedToolInput = reply.toolCall
    ? normalizeToolInput(reply.toolCall.name, reply.toolCall.input, goal)
    : null;
  const plannedToolCall =
    reply.toolCall && normalizedToolInput
      ? {
          id: reply.toolCall.id,
          name: reply.toolCall.name,
          input: normalizedToolInput,
        }
      : null;
  const directAnswer = reply.content;
  const nextAction = plannedToolCall
    ? `Prepare a ${plannedToolCall.name} draft from the collected file context.`
    : directAnswer
      ? "Return why no safe file edit can be prepared from the collected evidence."
      : "Return a grounded no-edit answer because the forced edit decision was invalid.";

  return {
    assistantMessage: reply.assistantMessage,
    directAnswer,
    nextAction,
    plan: [
      "Review the collected file context.",
      "Attempt one concrete edit tool decision.",
      "Only answer without editing if the evidence is insufficient.",
    ],
    toolCallId: plannedToolCall?.id ?? null,
    toolName: plannedToolCall?.name ?? null,
    toolInput: plannedToolCall?.input ?? null,
    step: createStep(
      `think-${roundNumber}`,
      "Think",
      `Force an edit-focused decision before finalizing an edit request. Next action: ${nextAction}`,
    ),
  };
}

async function thinkAfterReadForModification(
  context: AgentContext,
  goal: string,
  readToolRun: ToolRun,
  roundNumber: number,
  issuePlanText?: string | null,
): Promise<ThoughtResult> {
  if (context.sessionContext.readOnly) {
    return {
      assistantMessage: null,
      directAnswer:
        "Current session is read-only, so I cannot prepare a file modification draft. Exit read-only mode before asking me to modify files.",
      nextAction: "Return a read-only mode refusal instead of preparing a write draft.",
      plan: [
        "Review the existing file content.",
        "Notice that this session is read-only.",
        "Stop before preparing a write draft.",
      ],
      toolCallId: null,
      toolName: null,
      toolInput: null,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        "This session is read-only, so file modification tools are disabled.",
      ),
    };
  }

  const reply = await callModelForToolDecision(
    context.model,
    buildMessagesWithToolRuns(
      [
        {
          role: "system",
          content: buildFileModificationSystemPrompt(issuePlanText ?? null),
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
            `Target file path: ${readToolRun.inputText}`,
            issuePlanText ? "" : null,
            issuePlanText ? "Issue execution plan:" : null,
            issuePlanText ?? null,
          ].join("\n"),
        },
      ],
      [readToolRun],
    ),
    ["replace_text", "write_file"],
  );

  const normalizedToolInput = reply.toolCall
    ? normalizeToolInput(reply.toolCall.name, reply.toolCall.input, goal)
    : null;
  const plannedToolCall =
    reply.toolCall && normalizedToolInput
      ? {
          id: reply.toolCall.id,
          name: reply.toolCall.name,
          input: normalizedToolInput,
        }
      : null;
  const directAnswer = reply.content;
  const nextAction = plannedToolCall
    ? `Prepare a ${plannedToolCall.name} draft for "${readToolRun.inputText}".`
    : directAnswer
      ? "Ask the user for clarification before changing the file."
      : "Fallback to the normal second planning step because the tool decision was invalid.";

  return {
    assistantMessage: reply.assistantMessage,
    directAnswer,
    nextAction,
    plan: [
      "Review the existing file content.",
      "Apply the requested change safely.",
      "Prepare a write draft for approval.",
    ],
    toolCallId: plannedToolCall?.id ?? null,
    toolName: plannedToolCall?.name ?? null,
    toolInput: plannedToolCall?.input ?? null,
    step: createStep(
      `think-${roundNumber}`,
      "Think",
      `Use the read_file result to prepare a safe modification draft for "${readToolRun.inputText}". Next action: ${nextAction}`,
    ),
  };
}

function thinkAfterIssueDetailForPlanning(
  latestToolRun: ToolRun,
  roundNumber: number,
): ThoughtResult {
  const plannedToolCall = deriveIssuePlanToolCallFromToolRun(latestToolRun);

  if (!plannedToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction:
        "Fallback to the normal planner because the issue detail did not contain enough structured content to build a plan safely.",
      plan: [
        "Review the issue detail that was just loaded.",
        "Turn the issue into a code-change plan.",
        "Return a concrete next step and validation path.",
      ],
      toolCallId: null,
      toolName: null,
      toolInput: null,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        "The latest git_inspect issue_detail result did not contain enough structured issue content, so fall back to the normal planner.",
      ),
    };
  }

  return {
    assistantMessage: null,
    directAnswer: null,
    nextAction: `Use ${plannedToolCall.name} with input ${formatToolExecutionInput(plannedToolCall.input)}.`,
    plan: [
      "Review the structured issue detail that was just loaded.",
      "Convert that issue detail into an executable code-change plan.",
      "Return the plan before touching code.",
    ],
    toolCallId: plannedToolCall.id,
    toolName: plannedToolCall.name,
    toolInput: plannedToolCall.input,
    step: createStep(
      `think-${roundNumber}`,
      "Think",
      `Issue detail is already loaded, so convert it directly into an issue_plan with input ${formatToolExecutionInput(plannedToolCall.input)}.`,
    ),
  };
}

function thinkAfterIssuePlanForInvestigation(
  latestToolRun: ToolRun,
  roundNumber: number,
): ThoughtResult {
  const plannedToolCall = deriveIssueInvestigationToolCallFromToolRun(
    latestToolRun,
  );

  if (!plannedToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction:
        "Fallback to the normal planner because the issue plan did not contain a clear first investigation target.",
      plan: [
        "Review the code-change plan that was just created.",
        "Choose the safest first investigation step.",
        "Inspect code before editing anything.",
      ],
      toolCallId: null,
      toolName: null,
      toolInput: null,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        "The latest issue_plan did not include a clear file path or keyword, so fall back to the normal planner.",
      ),
    };
  }

  return {
    assistantMessage: null,
    directAnswer: null,
    nextAction: `Use ${plannedToolCall.name} with input ${formatToolExecutionInput(plannedToolCall.input)}.`,
    plan: [
      "Review the code-change plan that was just created.",
      "Use the plan to inspect one likely file or search one likely keyword.",
      "Collect real code context before deciding the edit.",
    ],
    toolCallId: plannedToolCall.id,
    toolName: plannedToolCall.name,
    toolInput: plannedToolCall.input,
    step: createStep(
      `think-${roundNumber}`,
      "Think",
      `Issue plan is ready, so start investigation with ${plannedToolCall.name} using ${formatToolExecutionInput(plannedToolCall.input)}.`,
    ),
  };
}

export const thinkStrategies: ThinkStrategy[] = [
  {
    match: (toolRuns, goal) => {
      const latestToolRun = toolRuns.at(-1);

      return (
        !!latestToolRun &&
        latestToolRun.name === "read_file" &&
        latestToolRun.result.ok &&
        (isFileModificationRequest(goal) || isIssueDrivenReadForDraft(toolRuns))
      );
    },
    think: ({
      context,
      perception,
      roundNumber,
      toolRuns,
    }) => {
      const latestToolRun = toolRuns.at(-1);

      if (!latestToolRun) {
        throw new Error("Expected latest tool run for read_file strategy.");
      }

      return thinkAfterReadForModification(
        context,
        perception.goal,
        latestToolRun,
        roundNumber,
        getLatestIssuePlanText(toolRuns),
      );
    },
  },
  {
    match: (toolRuns) => {
      const latestToolRun = toolRuns.at(-1);

      return !!latestToolRun && !!deriveIssuePlanToolCallFromToolRun(latestToolRun);
    },
    think: ({ roundNumber, toolRuns }) => {
      const latestToolRun = toolRuns.at(-1);

      if (!latestToolRun) {
        throw new Error("Expected latest tool run for issue planning strategy.");
      }

      return thinkAfterIssueDetailForPlanning(latestToolRun, roundNumber);
    },
  },
  {
    match: (toolRuns) => {
      const latestToolRun = toolRuns.at(-1);

      return (
        !!latestToolRun &&
        !!deriveIssueInvestigationToolCallFromToolRun(latestToolRun)
      );
    },
    think: ({ roundNumber, toolRuns }) => {
      const latestToolRun = toolRuns.at(-1);

      if (!latestToolRun) {
        throw new Error("Expected latest tool run for issue investigation strategy.");
      }

      return thinkAfterIssuePlanForInvestigation(latestToolRun, roundNumber);
    },
  },
];

export async function answerWithToolResults(
  context: AgentContext,
  goal: string,
  toolRuns: ToolRun[],
) {
  const response = await callModelForText(
    context.model,
    [
      {
        role: "system",
        content: buildAnswerWithToolResultsSystemPrompt(),
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
          "",
          "Use only these completed results to answer the user directly.",
        ].join("\n"),
      },
    ],
  );

  return response;
}

export async function answerDirectly(context: AgentContext, goal: string) {
  const response = await callModelForText(context.model, [
    {
      role: "system",
      content: buildAnswerDirectlySystemPrompt(context.toolNames),
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
        `Current task: ${goal}`,
      ].join("\n"),
    },
  ]);

  return response;
}
