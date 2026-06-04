import type {
  AgentResponse,
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
  getPendingWriteDraft,
  savePendingWriteDraft,
} from "@/lib/tools/pending-write";
import { createLogger } from "@/lib/logger";
import {
  formatConversationForModel,
  formatConversationSummaryForModel,
  normalizeSessionContext,
  prepareConversationContext,
} from "@/lib/agent/conversation-context";
import {
  callModelForText,
  callModelForToolDecision,
  type LlmMessage,
} from "@/lib/agent/model-client";
import {
  createMessage,
  createStep,
  emitStepsSnapshot,
  finishAgentRun,
  type RunAgentOptions,
} from "@/lib/agent/agent-response";
import {
  getNumberArg,
  getStringArg,
  getStringArrayArg,
  formatToolExecutionInput,
  formatToolRunsForModel,
} from "@/lib/agent/tool-args";
import {
  APPROVE_WRITE_COMMAND,
  CANCEL_WRITE_COMMAND,
  MAX_TOOL_CALLS,
  createSyntheticToolCallId,
  type ToolRun,
} from "@/lib/agent/tool-run-types";
import {
  buildNextSessionContext,
  formatSessionContextForModel,
} from "@/lib/agent/session-state";
import {
  handleWriteApproval,
  isAmbiguousDraftConfirmation,
  parseDraftLifecycleAction,
  parseWriteCommand,
} from "@/lib/agent/draft-lifecycle";
import { runToolCall } from "@/lib/agent/tool-runner";
import {
  deriveIssueInvestigationToolCallFromToolRun,
  deriveIssuePlanToolCallFromToolRun,
  extractIssuePlanFromGitInspectReport,
  formatIssueInvestigationAnswer,
  getLatestIssuePlanText,
  isIssueDrivenReadForDraft,
  parseGitInspectAction,
} from "@/lib/agent/issue-flow";
import {
  formatClickPageAnswer,
  formatReadPageAnswer,
} from "@/lib/agent/page-result-format";
import {
  deriveDirectClickToolCall,
  deriveDirectGitInspectToolCall,
  deriveDirectSafeCommandToolCall,
  deriveFocusedWebSearchQuery,
  derivePastedIssuePlanToolCall,
  deriveWebSearchQueryFromTask,
} from "@/lib/agent/direct-tool-plans";

type AgentContext = {
  cleanTask: string;
  recentConversation: ChatMessage[];
  sessionContext: AgentSessionContext;
  model: string;
  toolNames: string[];
};

type PerceptionResult = {
  goal: string;
  taskSize: string;
  step: AgentStep;
};

type ThoughtResult = {
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

function buildPlannerBudgetInstruction(toolRuns: ToolRun[], remainingToolCalls: number) {
  if (toolRuns.length === 0) {
    return "Choose between requesting the first tool or giving a direct answer.";
  }

  if (remainingToolCalls > 0) {
    return `You have already seen ${toolRuns.length} tool result${toolRuns.length === 1 ? "" : "s"}. Choose one next tool call or give the final answer now.`;
  }

  return "No more tool calls remain. Give the final answer now.";
}

function getImmediateToolOutcome(goal: string, toolRuns: ToolRun[]) {
  const toolRun = toolRuns.at(-1);

  if (!toolRun) {
    return null;
  }

  if ((toolRun.name === "read_page" || toolRun.name === "click_page") && !toolRun.result.ok) {
    return {
      actDetail: `Run "${toolRun.name}", stop after the tool failure, and return the tool error directly.`,
      message: toolRun.result.content,
    };
  }

  if (toolRun.name === "read_page" && toolRun.result.ok) {
    const formattedReadPageAnswer = formatReadPageAnswer(goal, toolRun.result.content);

    if (formattedReadPageAnswer) {
      return {
        actDetail:
          `Run "${toolRun.name}" and return the page URL, title, and visible text sample directly in a fixed format.`,
        message: formattedReadPageAnswer,
      };
    }
  }

  if (toolRun.name === "click_page" && toolRun.result.ok) {
    const formattedClickPageAnswer = formatClickPageAnswer(goal, toolRun.result.content);

    if (formattedClickPageAnswer) {
      return {
        actDetail:
          `Run "${toolRun.name}" and return the clicked selector, page URL, title, and visible text sample directly in a fixed format.`,
        message: formattedClickPageAnswer,
      };
    }
  }

  if (toolRun.result.draft) {
    const draftPath = toolRun.result.draft.path ?? "the requested file";

    return {
      actDetail:
        `Prepare a ${toolRun.name} draft for "${draftPath}" and stop for explicit approval without writing anything to disk.`,
      message: toolRun.result.content,
    };
  }

  if (
    toolRun.name === "safe_command" &&
    isVerificationSafeCommandInput(toolRun.input)
  ) {
    return {
      actDetail:
        `Run "${toolRun.name}" for repository or build verification, then return the structured command report directly.`,
      message: toolRun.result.content,
    };
  }

  if (
    toolRun.name === "git_inspect" &&
    toolRun.result.ok &&
    parseGitInspectAction(toolRun.result.content) === "issue_plan"
  ) {
    const issuePlan = extractIssuePlanFromGitInspectReport(toolRun.result.content);

    if (issuePlan && !deriveIssueInvestigationToolCallFromToolRun(toolRun)) {
      return {
        actDetail:
          `Run "${toolRun.name}" to turn the issue into a concrete code-change plan, then return that plan directly.`,
        message: issuePlan,
      };
    }
  }

  const issueInvestigationAnswer = formatIssueInvestigationAnswer(goal, toolRuns);

  if (issueInvestigationAnswer && !isIssueDrivenReadForDraft(toolRuns)) {
    return {
      actDetail:
        `Run "${toolRun.name}" as the first issue investigation step, then return a concrete next-step summary instead of continuing to edit code immediately.`,
      message: issueInvestigationAnswer,
    };
  }

  return null;
}

function isVerificationSafeCommandInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return false;
  }

  const command = getStringArg(input, "command").toLowerCase();
  const args = getStringArrayArg(input, "args");

  if (command === "git" && args.length === 1 && args[0] === "status") {
    return true;
  }

  return (
    command === "npm" &&
    ((args.length === 2 && args[0] === "run" && args[1] === "build") ||
      (args.length === 1 && args[0] === "test"))
  );
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

function perceive(context: AgentContext): PerceptionResult {
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

function isFileModificationRequest(task: string) {
  return (
    /(modify|edit|update|change|append|replace|rewrite|revise)/i.test(task) ||
    /(修改|编辑|更新|改动|追加|替换|重写|删除|增加)/u.test(task)
  );
}
async function think(
  context: AgentContext,
  perception: PerceptionResult,
  toolRuns: ToolRun[],
): Promise<ThoughtResult> {
  const availableTools = listTools();
  const roundNumber = toolRuns.length + 1;
  const remainingToolCalls = getRemainingToolCalls(toolRuns);
  const plan = buildThoughtPlan(toolRuns, remainingToolCalls);

  const toolList = availableTools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description} Input form: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join("\n");

  const directClickToolCall =
    toolRuns.length === 0 ? deriveDirectClickToolCall(perception.goal) : null;
  const directPastedIssuePlanToolCall =
    toolRuns.length === 0 ? derivePastedIssuePlanToolCall(perception.goal) : null;
  const directGitInspectToolCall =
    toolRuns.length === 0 ? deriveDirectGitInspectToolCall(perception.goal) : null;
  const directSafeCommandToolCall =
    toolRuns.length === 0 ? deriveDirectSafeCommandToolCall(perception.goal) : null;

  if (directClickToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction: `Use ${directClickToolCall.name} with input ${formatToolExecutionInput(directClickToolCall.input)}.`,
      plan,
      toolCallId: directClickToolCall.id,
      toolName: directClickToolCall.name,
      toolInput: directClickToolCall.input,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: Use ${directClickToolCall.name} with input ${formatToolExecutionInput(directClickToolCall.input)}.`,
      ),
    };
  }

  if (directPastedIssuePlanToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction: `Use ${directPastedIssuePlanToolCall.name} with input ${formatToolExecutionInput(directPastedIssuePlanToolCall.input)}.`,
      plan,
      toolCallId: directPastedIssuePlanToolCall.id,
      toolName: directPastedIssuePlanToolCall.name,
      toolInput: directPastedIssuePlanToolCall.input,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: Use ${directPastedIssuePlanToolCall.name} with input ${formatToolExecutionInput(directPastedIssuePlanToolCall.input)}.`,
      ),
    };
  }

  if (directGitInspectToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction: `Use ${directGitInspectToolCall.name} with input ${formatToolExecutionInput(directGitInspectToolCall.input)}.`,
      plan,
      toolCallId: directGitInspectToolCall.id,
      toolName: directGitInspectToolCall.name,
      toolInput: directGitInspectToolCall.input,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: Use ${directGitInspectToolCall.name} with input ${formatToolExecutionInput(directGitInspectToolCall.input)}.`,
      ),
    };
  }

  if (directSafeCommandToolCall) {
    return {
      assistantMessage: null,
      directAnswer: null,
      nextAction: `Use ${directSafeCommandToolCall.name} with input ${formatToolExecutionInput(directSafeCommandToolCall.input)}.`,
      plan,
      toolCallId: directSafeCommandToolCall.id,
      toolName: directSafeCommandToolCall.name,
      toolInput: directSafeCommandToolCall.input,
      step: createStep(
        `think-${roundNumber}`,
        "Think",
        `Plan round ${roundNumber}: ${plan.join(" ")} Available tools: ${availableTools.map((tool) => tool.name).join(", ")}. Next action: Use ${directSafeCommandToolCall.name} with input ${formatToolExecutionInput(directSafeCommandToolCall.input)}.`,
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

async function answerWithToolResults(
  context: AgentContext,
  goal: string,
  toolRuns: ToolRun[],
) {
  if (toolRuns.length === 1 && toolRuns[0]?.name === "read_page") {
    const formattedReadPageAnswer = formatReadPageAnswer(
      goal,
      toolRuns[0].result.content,
    );

    if (formattedReadPageAnswer) {
      return {
        content: formattedReadPageAnswer,
      };
    }
  }

  if (toolRuns.length === 1 && toolRuns[0]?.name === "click_page") {
    const formattedClickPageAnswer = formatClickPageAnswer(
      goal,
      toolRuns[0].result.content,
    );

    if (formattedClickPageAnswer) {
      return {
        content: formattedClickPageAnswer,
      };
    }
  }

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

async function answerDirectly(context: AgentContext, goal: string) {
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

export async function runAgent(
  task: string,
  messages: ChatMessage[] = [],
  sessionContext: AgentSessionContext = {},
  requestId: string,
  options: RunAgentOptions = {},
): Promise<AgentResponse> {
  const onEvent = options.onEvent;
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
  const backendPendingDraft = getPendingWriteDraft();
  const effectiveSessionContext: AgentSessionContext = {
    ...normalizedSessionContext,
    pendingDraft: backendPendingDraft ?? null,
  };
  const exactWriteCommand = parseWriteCommand(task);
  const draftLifecycleAction = exactWriteCommand
    ? null
    : parseDraftLifecycleAction(task);

  const writeApprovalResult = await handleWriteApproval(task);
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

  if (draftLifecycleAction && !backendPendingDraft) {
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
    backendPendingDraft &&
    !draftLifecycleAction &&
    isAmbiguousDraftConfirmation(task)
  ) {
    return finishWithLogging(
      {
        message: createMessage(
          [
            "I found a pending draft, but your confirmation word was too vague.",
            `Draft id: ${backendPendingDraft.id}`,
            `Target path: ${backendPendingDraft.path}`,
            `If you want to write it, say: ${APPROVE_WRITE_COMMAND} ${backendPendingDraft.id}`,
            `Or simply reply: approve / 批准`,
            `If you want to discard it, say: ${CANCEL_WRITE_COMMAND} ${backendPendingDraft.id}`,
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
    backendPendingDraft
  ) {
    const approvalResult = await handleWriteApproval(
      `${APPROVE_WRITE_COMMAND} ${backendPendingDraft.id}`,
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
    backendPendingDraft
  ) {
    const cancelResult = await handleWriteApproval(
      `${CANCEL_WRITE_COMMAND} ${backendPendingDraft.id}`,
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

  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("Missing DEEPSEEK_API_KEY.");
  }

  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
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
    toolNames: listTools().map((tool) => tool.name),
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
    const latestToolRun = toolRuns.at(-1) ?? null;
    const thought =
      latestToolRun &&
      latestToolRun.name === "read_file" &&
      latestToolRun.result.ok &&
      (isFileModificationRequest(perception.goal) ||
        isIssueDrivenReadForDraft(toolRuns))
        ? await thinkAfterReadForModification(
            context,
            perception.goal,
            latestToolRun,
            roundNumber,
            getLatestIssuePlanText(toolRuns),
          )
        : latestToolRun &&
            deriveIssuePlanToolCallFromToolRun(latestToolRun)
          ? thinkAfterIssueDetailForPlanning(latestToolRun, roundNumber)
        : latestToolRun &&
            deriveIssueInvestigationToolCallFromToolRun(latestToolRun)
          ? thinkAfterIssuePlanForInvestigation(latestToolRun, roundNumber)
        : await think(context, perception, toolRuns);

    await pushStep(thought.step);

    if (!thought.toolName || !thought.toolInput) {
      const reply =
        toolRuns.length === 0
          ? thought.directAnswer
            ? {
                content: thought.directAnswer,
                reasoning_content: thought.assistantMessage?.reasoning_content ?? null,
              }
            : await answerDirectly(context, perception.goal)
          : thought.directAnswer
            ? {
                content: thought.directAnswer,
                reasoning_content: thought.assistantMessage?.reasoning_content ?? null,
              }
            :
            (await answerWithToolResults(context, perception.goal, toolRuns));

      await pushStep(
        createStep(
          `act-${roundNumber}`,
          "Act",
          toolRuns.length === 0
            ? thought.directAnswer
              ? "Return the model's direct answer without using a tool."
              : `Call DeepSeek model "${context.model}" and return one assistant message to the chat UI.`
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
      toolRun = await runToolCall(
        thought.toolName,
        thought.toolInput,
        thought.toolCallId ?? createSyntheticToolCallId(),
        thought.assistantMessage ?? {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [
            {
              id: thought.toolCallId ?? createSyntheticToolCallId(),
              type: "function",
              function: {
                name: thought.toolName,
                arguments: formatToolExecutionInput(thought.toolInput),
              },
            },
          ],
        },
      );
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

    await pushStep(
      createStep(
        `act-${roundNumber}`,
        "Act",
        `Run tool call ${toolRuns.length} with "${toolRun.name}" using input ${toolRun.inputText} and capture the result for the next decision.`,
      ),
    );

    const immediateOutcome = getImmediateToolOutcome(perception.goal, toolRuns);
    if (immediateOutcome) {
      if (toolRun.result.draft) {
        savePendingWriteDraft(toolRun.result.draft);
      }

      await replaceLastStep(
        createStep(`act-${roundNumber}`, "Act", immediateOutcome.actDetail),
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
      const finalReply = await answerWithToolResults(context, perception.goal, toolRuns);

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
