import type {
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";
import { listTools } from "@/lib/tools/tool-registry";
import type { ToolCallArgs, ToolExecutionInput } from "@/lib/tools/types";
import {
  formatConversationForModel,
  formatConversationSummaryForModel,
} from "@/lib/agent/conversation-context";
import {
  callModelForToolDecision,
  type LlmMessage,
} from "@/lib/agent/model-client";
import { createStep } from "@/lib/agent/agent-response";
import {
  getNumberArg,
  getStringArg,
  getStringArrayArg,
  formatToolExecutionInput,
} from "@/lib/agent/tool-args";
import { MAX_TOOL_CALLS, type ToolRun } from "@/lib/agent/tool-run-types";
import { formatSessionContextForModel } from "@/lib/agent/session-state";
import {
  deriveFocusedWebSearchQuery,
  deriveWebSearchQueryFromTask,
} from "@/lib/agent/direct-tool-plans";
import { buildPlannerSystemPrompt } from "./prompts";

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

function getRemainingToolCalls(toolRuns: ToolRun[]) {
  return Math.max(MAX_TOOL_CALLS - toolRuns.length, 0);
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

function normalizeToolInput(
  toolName: string,
  rawInput: ToolCallArgs,
  task: string,
) {
  if (toolName === "task_plan" || toolName === "finish_task") return rawInput;
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

    if (!command) {
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
      query: deriveFocusedWebSearchQuery(
        deriveWebSearchQueryFromTask(query || task),
      ),
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

function buildMessagesWithToolRuns(
  baseMessages: LlmMessage[],
  toolRuns: ToolRun[],
) {
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

export async function think(
  context: AgentContext,
  perception: PerceptionResult,
  toolRuns: ToolRun[],
): Promise<ThoughtResult> {
  const readOnly = context.sessionContext.readOnly === true;
  const availableTools = listTools({ readOnly });
  const roundNumber = toolRuns.length + 1;
  const remainingToolCalls = getRemainingToolCalls(toolRuns);
  const plan = buildThoughtPlan(toolRuns, remainingToolCalls);

  const toolList = availableTools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description} Input form: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join("\n");

  const plannerReply = await callModelForToolDecision(
    context.model,
    buildMessagesWithToolRuns(
      [
        {
          role: "system",
          content: buildPlannerSystemPrompt({
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
    context.sessionContext.workflow?.plan ? context.toolNames : ["task_plan"],
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
      ? "Ask the model for a structured finish_task decision."
      : "Ask the model to correct its missing or invalid tool decision.";

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
