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
  MAX_TOOL_CALLS,
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

function buildPlannerBudgetInstruction(toolRuns: ToolRun[], remainingToolCalls: number) {
  if (toolRuns.length === 0) {
    return "Choose between requesting the first tool or giving a direct answer.";
  }

  if (remainingToolCalls > 0) {
    return `You have already seen ${toolRuns.length} tool result${toolRuns.length === 1 ? "" : "s"}. Choose one next tool call or give the final answer now.`;
  }

  return "No more tool calls remain. Give the final answer now.";
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
  return (
    /(modify|edit|update|change|append|replace|rewrite|revise|write|create|overwrite|delete|remove)/i.test(task) ||
    /(淇敼|缂栬緫|鏇存柊|鏀瑰姩|杩藉姞|鏇挎崲|閲嶅啓|鍒犻櫎|澧炲姞)/u.test(task)
  );
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
          content: [
            "You are the planning step for a stripped-down coding agent.",
            "You may request at most one tool in each reply.",
            `The full user request may use at most ${MAX_TOOL_CALLS} tool calls total.`,
            buildPlannerBudgetInstruction(toolRuns, remainingToolCalls),
            readOnly
              ? "This session is read-only. Do not modify files. The write_file and replace_text tools are unavailable."
              : "",
            "If the user wants to modify an existing file, first use read_file to get the current content.",
            "If the user asks for one exact text replacement inside an existing file, prefer replace_text after read_file.",
            "If the user asks to create, edit, or overwrite a file and the change is broader than one exact replacement, prefer the write_file tool.",
            "If the user asks to open a web page, inspect a URL, or read page content from a live site, prefer read_page.",
            "If the user asks to click one simple link, button, or tab on a live page, prefer click_page.",
            "If the user asks whether the current workspace is a Git repository, prefer git_inspect with action check_repo.",
            "If the user asks for one specific issue detail, prefer git_inspect with action issue_detail and include the issue_number.",
            'If the user asks you to turn an issue into an execution plan, prefer git_inspect with action issue_plan. Pass pasted issue text in issue_text, or pass issue_number when the user names one GitHub issue number.',
            "If the user asks for the current repository issue list, prefer git_inspect with action issue_list.",
            "If the user asks for current GitHub repository info, prefer git_inspect with action repo_info.",
            "If the user asks for a PR draft suggestion, prefer git_inspect with action pr_draft.",
            "If the user asks to export a patch, generate patch text, or produce a diff patch, prefer git_inspect with action patch_export. This is read-only and must not commit or push.",
            "If the user asks for a task_submit draft or task submit text, prefer git_inspect with action task_submit. This is read-only and must not commit, push, or actually submit anything.",
            "If the user asks for a commit message suggestion, prefer git_inspect with action commit_message.",
            "If the user asks whether the workspace is connected to GitHub, or asks about remotes, GitHub remotes, gh CLI, or GitHub login readiness, prefer git_inspect with action github_env.",
            "If the user asks for git status or repository status, prefer git_inspect with action status.",
            "If the user asks for git diff or repository diff, prefer git_inspect with action diff.",
            "If the user asks for a Git change summary, prefer git_inspect with action summary.",
            "If the user explicitly asks to run a local command, prefer safe_command instead of inventing shell output.",
            "If the user asks to build, compile, or verify whether the project still builds, prefer safe_command with npm run build.",
            "If the user asks you to search the web, look something up online, or needs current public information, prefer web_search.",
            "Available tools:",
            toolList,
            "If you need one tool, call exactly one tool using the provided function definitions.",
            "Fill tool arguments as JSON that matches the tool's input form.",
            "Do not use safe_command for network access, shell wrappers, or any command outside its allowlist.",
            "If you do not need a tool, answer normally in plain text.",
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
          content: [
            "You are the editing step for a stripped-down coding agent.",
            "The user wants to modify an existing file.",
            "You already have the current file content from read_file.",
            "If one exact old snippet can be safely replaced with one new snippet, call the replace_text tool first.",
            "If the change is broader than one exact replacement, call the write_file tool.",
            "The write_file content argument must contain the full final file content, not a diff.",
            issuePlanText
              ? "This read_file step came from an issue execution plan. If the likely fix is clear enough from the issue plan plus the current file content, prepare the smallest safe draft now."
              : "Work only from the explicit user edit request and the current file content.",
            "If the change request is too ambiguous to apply safely, ask the user one short clarifying question in plain text.",
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
        content:
          "You are a stripped-down Codex-style coding assistant. Reply in the same language as the user. Be concise, practical, and clear. Use the completed tool results below to answer the user directly. If web_search was used, keep the result titles and links visible in the answer. If read_page was used, present the result as three labeled lines: final URL, page title, and a short visible text sample. Do not request another tool. Do not output tool-call markup, XML tags, or DSML blocks.",
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
      content:
        `You are a stripped-down Codex-style coding assistant. Reply in the same language as the user. Be concise, practical, and clear. Available tools for future steps: ${context.toolNames.join(", ")}.`,
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
