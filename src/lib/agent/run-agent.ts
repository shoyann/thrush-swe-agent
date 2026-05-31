import { existsSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type {
  AgentResponse,
  AgentSessionContext,
  AgentStep,
  AgentStreamEvent,
  ChatMessage,
} from "@/types/agent";
import { getTool, listTools } from "@/lib/tools/tool-registry";
import type {
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import {
  applyPendingWriteDraft,
  clearPendingWriteDraft,
  getPendingWriteDraft,
  savePendingWriteDraft,
} from "@/lib/tools/pending-write";
import { createLogger } from "@/lib/logger";
import { getWorkspaceRoot } from "@/lib/tools/workspace-path";

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
  toolInput: ToolCallArgs | null;
  toolName: string | null;
};

type PlannedToolCall = {
  id: string;
  input: ToolCallArgs;
  name: string;
};

type DirectToolPlan = {
  id: string;
  input: ToolCallArgs;
  name: string;
};

type ToolRun = {
  assistantMessage: LlmMessage;
  input: ToolExecutionInput;
  inputText: string;
  name: string;
  result: ToolResult;
  toolCallId: string;
};

type ModelTextMessage = {
  content: string;
  reasoning_content?: string | null;
};

type ModelToolMessage = {
  assistantMessage: LlmMessage;
  content: string | null;
  toolCall: PlannedToolCall | null;
};

type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ text?: string; type?: string }> | null;
  reasoning_content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
});

const APPROVE_WRITE_COMMAND = "APPROVE_WRITE";
const CANCEL_WRITE_COMMAND = "CANCEL_WRITE";
const MAX_CONTEXT_MESSAGES = 8;
const MAX_TOOL_CALLS = 4;

type WriteCommand =
  | {
      type: "approve" | "cancel";
      draftId: string | null;
    }
  | null;

export type RunAgentOptions = {
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
};

function createStep(id: string, title: string, detail: string): AgentStep {
  return {
    id,
    title,
    detail,
    status: "done",
  };
}

function createMessage(content: string, reasoningContent?: string | null): ChatMessage {
  return {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

function cloneSteps(steps: AgentStep[]) {
  return steps.map((step) => ({ ...step }));
}

async function emitAgentEvent(
  onEvent: RunAgentOptions["onEvent"],
  event: AgentStreamEvent,
) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}

async function emitStepsSnapshot(
  steps: AgentStep[],
  onEvent: RunAgentOptions["onEvent"],
) {
  await emitAgentEvent(onEvent, {
    type: "steps",
    steps: cloneSteps(steps),
  });
}

async function finishAgentRun(
  response: AgentResponse,
  onEvent: RunAgentOptions["onEvent"],
  includeSteps: boolean,
) {
  if (includeSteps) {
    await emitStepsSnapshot(response.steps, onEvent);
  }

  await emitAgentEvent(onEvent, {
    type: "message",
    message: response.message,
  });
  await emitAgentEvent(onEvent, {
    type: "done",
    sessionContext: response.sessionContext,
  });

  return response;
}

function getMessageTextContent(
  content: string | Array<{ text?: string; type?: string }> | null | undefined,
) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function callModelForText(
  model: string,
  messages: LlmMessage[],
) : Promise<ModelTextMessage> {
  const response = await client.chat.completions.create({
    model,
    messages,
    extra_body: {
      thinking: {
        type: "disabled",
      },
    },
  } as never);

  const message = response.choices[0]?.message;
  const content = getMessageTextContent(message?.content);
  const reasoningContent = getReasoningContent(message);

  return {
    content: content || "I reached the model, but it did not return usable text.",
    reasoning_content: reasoningContent,
  };
}

function buildModelTools(allowedToolNames?: string[]) {
  const allowedSet = allowedToolNames ? new Set(allowedToolNames) : null;

  return listTools()
    .filter((tool) => (allowedSet ? allowedSet.has(tool.name) : true))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

function parseToolCallArguments(rawArguments: string) {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as ToolCallArgs;
  } catch {
    return null;
  }
}

function createSyntheticToolCallId() {
  return `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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

function getReasoningContent(message: unknown) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof reasoningContent === "string" ? reasoningContent : null;
}

async function callModelForToolDecision(
  model: string,
  messages: LlmMessage[],
  allowedToolNames?: string[],
): Promise<ModelToolMessage> {
  const response = await client.chat.completions.create({
    model,
    messages,
    tools: buildModelTools(allowedToolNames),
    tool_choice: "auto",
    extra_body: {
      thinking: {
        type: "disabled",
      },
    },
  } as never);

  const message = response.choices[0]?.message;
  const firstToolCall = message?.tool_calls?.[0];
  const content = getMessageTextContent(message?.content) || null;
  const reasoningContent = getReasoningContent(message);
  const assistantMessage: LlmMessage = {
    role: "assistant",
    content: message?.content ?? null,
    reasoning_content: reasoningContent,
    tool_calls:
      firstToolCall?.type === "function"
        ? [
            {
              id: firstToolCall.id || createSyntheticToolCallId(),
              type: "function",
              function: {
                name: firstToolCall.function.name,
                arguments: firstToolCall.function.arguments,
              },
            },
          ]
        : undefined,
  };

  if (firstToolCall?.type !== "function") {
    return {
      assistantMessage,
      content,
      toolCall: null,
    };
  }

  const parsedArguments = parseToolCallArguments(firstToolCall.function.arguments);
  if (!parsedArguments) {
    return {
      assistantMessage,
      content,
      toolCall: null,
    };
  }

  return {
    assistantMessage,
    content,
    toolCall: {
      id: assistantMessage.tool_calls?.[0]?.id || createSyntheticToolCallId(),
      name: firstToolCall.function.name,
      input: parsedArguments,
    },
  };
}

function normalizeConversationHistory(messages: ChatMessage[] | undefined, task: string) {
  if (!messages?.length) {
    return [];
  }

  const normalizedMessages = messages
    .filter((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return false;
      }

      return message.content.trim().length > 0;
    })
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }));

  if (normalizedMessages.length === 0) {
    return [];
  }

  const lastMessage = normalizedMessages.at(-1);
  const recentMessages =
    lastMessage?.role === "user" && lastMessage.content === task.trim()
      ? normalizedMessages.slice(0, -1)
      : normalizedMessages;

  return recentMessages.slice(-MAX_CONTEXT_MESSAGES);
}

function normalizeSessionContext(
  sessionContext: AgentSessionContext | undefined,
): AgentSessionContext {
  if (!sessionContext) {
    return {};
  }

  return {
    lastListedDirectoryPath: sessionContext.lastListedDirectoryPath?.trim() || null,
    lastReadFilePath: sessionContext.lastReadFilePath?.trim() || null,
    lastToolInput: sessionContext.lastToolInput?.trim() || null,
    lastToolName: sessionContext.lastToolName?.trim() || null,
    pendingDraft: sessionContext.pendingDraft
      ? {
          ...sessionContext.pendingDraft,
          content: sessionContext.pendingDraft.content,
          id: sessionContext.pendingDraft.id.trim(),
          path: sessionContext.pendingDraft.path.trim(),
        }
      : null,
  };
}

function formatConversationForModel(messages: ChatMessage[]) {
  if (messages.length === 0) {
    return "No recent conversation.";
  }

  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

function formatSessionContextForModel(sessionContext: AgentSessionContext) {
  const lines = [
    `Last tool name: ${sessionContext.lastToolName ?? "none"}`,
    `Last tool input: ${sessionContext.lastToolInput ?? "none"}`,
    `Last listed directory: ${sessionContext.lastListedDirectoryPath ?? "none"}`,
    `Last read file: ${sessionContext.lastReadFilePath ?? "none"}`,
  ];

  if (sessionContext.pendingDraft) {
    lines.push(`Pending draft id: ${sessionContext.pendingDraft.id}`);
    lines.push(`Pending draft path: ${sessionContext.pendingDraft.path}`);
    lines.push("Pending draft content:");
    lines.push(sessionContext.pendingDraft.content || "(empty file)");
  } else {
    lines.push("Pending draft id: none");
  }

  lines.push(
    "Reference rules: if the user says 'that draft' or '那个 draft', prefer the pending draft. If the user says 'that file' or '那个文件', prefer the pending draft path first, then the last read file. If the user says 'continue the last step' or '继续上一步', prefer continuing the pending draft flow, otherwise use the last tool context.",
  );

  return lines.join("\n");
}

function buildNextSessionContext(
  previousContext: AgentSessionContext,
  toolRuns: ToolRun[],
): AgentSessionContext {
  const nextContext: AgentSessionContext = {
    ...previousContext,
  };

  for (const toolRun of toolRuns) {
    nextContext.lastToolName = toolRun.name;
    nextContext.lastToolInput = toolRun.inputText;

    if (toolRun.name === "list_files") {
      nextContext.lastListedDirectoryPath = getToolPathReference(toolRun.input);
    }

    if (toolRun.name === "read_file") {
      nextContext.lastReadFilePath = getToolPathReference(toolRun.input);
    }

    if (toolRun.result.draft) {
      nextContext.pendingDraft = toolRun.result.draft;
    }
  }

  return nextContext;
}

function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function getStringArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function getStringArrayArg(args: ToolCallArgs, key: string) {
  const value = args[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function getNumberArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getToolPathReference(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input.trim() || null;
  }

  return getStringArg(input, "path") || null;
}

function formatToolExecutionInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input;
  }

  return JSON.stringify(input);
}

function formatToolRunsForModel(toolRuns: ToolRun[]) {
  return toolRuns
    .map((toolRun, index) =>
      [
        `Tool result ${index + 1}:`,
        `name: ${toolRun.name}`,
        `input: ${toolRun.inputText}`,
        `ok: ${toolRun.result.ok ? "true" : "false"}`,
        "content:",
        toolRun.result.content,
      ].join("\n"),
    )
    .join("\n\n");
}

function parseReadPageToolContent(content: string) {
  const lines = content.split(/\r?\n/);
  const finalUrlLine = lines.find((line) => line.startsWith("final_url: "));
  const pageTitleLine = lines.find((line) => line.startsWith("page_title: "));
  const visibleTextIndex = lines.findIndex((line) => line === "visible_text_sample:");

  if (!finalUrlLine || !pageTitleLine || visibleTextIndex === -1) {
    return null;
  }

  return {
    finalUrl: finalUrlLine.slice("final_url: ".length).trim(),
    pageTitle: pageTitleLine.slice("page_title: ".length).trim(),
    visibleTextSample: lines.slice(visibleTextIndex + 1).join("\n").trim(),
  };
}

function parseClickPageToolContent(content: string) {
  const lines = content.split(/\r?\n/);
  const clickedSelectorLine = lines.find((line) =>
    line.startsWith("clicked_selector: "),
  );
  const finalUrlLine = lines.find((line) => line.startsWith("final_url: "));
  const pageTitleLine = lines.find((line) => line.startsWith("page_title: "));
  const visibleTextIndex = lines.findIndex((line) => line === "visible_text_sample:");

  if (
    !clickedSelectorLine ||
    !finalUrlLine ||
    !pageTitleLine ||
    visibleTextIndex === -1
  ) {
    return null;
  }

  return {
    clickedSelector: clickedSelectorLine
      .slice("clicked_selector: ".length)
      .trim(),
    finalUrl: finalUrlLine.slice("final_url: ".length).trim(),
    pageTitle: pageTitleLine.slice("page_title: ".length).trim(),
    visibleTextSample: lines.slice(visibleTextIndex + 1).join("\n").trim(),
  };
}

function parseReportSection(
  content: string,
  sectionName: string,
  nextSectionNames: string[],
) {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex(
    (line) => line.trim() === `${sectionName}:`,
  );

  if (startIndex === -1) {
    return null;
  }

  const collectedLines: string[] = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmedLine = lines[index]?.trim();

    if (nextSectionNames.some((name) => trimmedLine === `${name}:`)) {
      break;
    }

    collectedLines.push(lines[index] ?? "");
  }

  const sectionContent = collectedLines.join("\n").trim();
  return sectionContent && sectionContent !== "(none)" ? sectionContent : null;
}

function parseGitInspectAction(content: string) {
  const match = content.match(/^action:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractIssueDetailFromGitInspectReport(content: string) {
  return parseReportSection(content, "issue_detail", ["issue_list"]);
}

function extractIssuePlanFromGitInspectReport(content: string) {
  return parseReportSection(content, "issue_plan", ["repo_info"]);
}

function isStructuredIssueDetail(text: string) {
  return /^#\d+\s+\[[A-Z]+\]\s+/m.test(text);
}

function deriveIssuePlanToolCallFromToolRun(
  toolRun: ToolRun,
): PlannedToolCall | null {
  if (toolRun.name !== "git_inspect" || !toolRun.result.ok) {
    return null;
  }

  if (parseGitInspectAction(toolRun.result.content) !== "issue_detail") {
    return null;
  }

  const issueDetail = extractIssueDetailFromGitInspectReport(toolRun.result.content);

  if (!issueDetail || !isStructuredIssueDetail(issueDetail)) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "git_inspect",
    input: {
      action: "issue_plan",
      issue_text: issueDetail,
    },
  };
}

function extractBulletItems(sectionContent: string | null) {
  if (!sectionContent) {
    return [];
  }

  return sectionContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function looksLikeWorkspacePath(value: string) {
  return /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html)$/i.test(
    value,
  );
}

function getDefaultIssueSearchPath() {
  const workspaceRoot = getWorkspaceRoot();
  const candidatePath =
    ["src", "app", "pages", "components", "lib"].find((candidate) =>
      existsSync(path.join(workspaceRoot, candidate)),
    ) ?? ".";

  return candidatePath;
}

function extractIssuePlanCandidatePaths(issuePlan: string) {
  return extractBulletItems(
    parseReportSection(issuePlan, "Possible related files or modules", [
      "Useful search keywords",
    ]),
  ).filter((item) => looksLikeWorkspacePath(item));
}

function extractIssuePlanKeywords(issuePlan: string) {
  const keywordLines = extractBulletItems(
    parseReportSection(issuePlan, "Useful search keywords", [
      "Recommended first step",
    ]),
  );

  if (keywordLines.length === 0) {
    return [];
  }

  return keywordLines
    .flatMap((line) => line.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "(need manual triage)");
}

function deriveIssueInvestigationToolCallFromToolRun(
  toolRun: ToolRun,
): PlannedToolCall | null {
  if (toolRun.name !== "git_inspect" || !toolRun.result.ok) {
    return null;
  }

  if (parseGitInspectAction(toolRun.result.content) !== "issue_plan") {
    return null;
  }

  const issuePlan = extractIssuePlanFromGitInspectReport(toolRun.result.content);

  if (!issuePlan) {
    return null;
  }

  const candidatePaths = extractIssuePlanCandidatePaths(issuePlan);
  if (candidatePaths.length > 0) {
    return {
      id: createSyntheticToolCallId(),
      name: "read_file",
      input: {
        path: candidatePaths[0],
      },
    };
  }

  const keywords = extractIssuePlanKeywords(issuePlan);
  if (keywords.length > 0) {
    return {
      id: createSyntheticToolCallId(),
      name: "search_text",
      input: {
        query: keywords[0],
        path: getDefaultIssueSearchPath(),
      },
    };
  }

  return null;
}

function findLatestIssuePlanIndex(toolRuns: ToolRun[]) {
  for (let index = toolRuns.length - 1; index >= 0; index -= 1) {
    const toolRun = toolRuns[index];
    if (
      toolRun.name === "git_inspect" &&
      toolRun.result.ok &&
      parseGitInspectAction(toolRun.result.content) === "issue_plan" &&
      extractIssuePlanFromGitInspectReport(toolRun.result.content)
    ) {
      return index;
    }
  }

  return -1;
}

function getLatestIssuePlanText(toolRuns: ToolRun[]) {
  const latestIssuePlanIndex = findLatestIssuePlanIndex(toolRuns);

  if (latestIssuePlanIndex === -1) {
    return null;
  }

  return extractIssuePlanFromGitInspectReport(
    toolRuns[latestIssuePlanIndex]?.result.content ?? "",
  );
}

function isIssueDrivenReadForDraft(toolRuns: ToolRun[]) {
  const latestToolRun = toolRuns.at(-1);

  if (
    !latestToolRun ||
    latestToolRun.name !== "read_file" ||
    !latestToolRun.result.ok
  ) {
    return false;
  }

  const latestIssuePlanIndex = findLatestIssuePlanIndex(toolRuns);
  return latestIssuePlanIndex !== -1 && latestIssuePlanIndex < toolRuns.length - 1;
}

function extractIssueGoalFromPlan(issuePlan: string) {
  const goalLines = extractBulletItems(
    parseReportSection(issuePlan, "What this issue is trying to fix", [
      "Possible related files or modules",
    ]),
  );

  return goalLines[0] ?? "Need manual issue summary.";
}

function buildPreviewText(content: string, maxLines: number, maxChars: number) {
  const preview = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .join("\n")
    .trim();

  if (!preview) {
    return "(empty)";
  }

  if (preview.length <= maxChars) {
    return preview;
  }

  return `${preview.slice(0, maxChars)}\n[preview truncated]`;
}

function parseSearchResultMatches(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[^:\s][^:]*:\d+:\s/.test(line))
    .map((line) => {
      const match = line.match(/^(.*?):(\d+):\s*(.*)$/);
      return match
        ? {
            path: match[1].trim(),
            line: match[2].trim(),
            snippet: match[3].trim(),
          }
        : null;
    })
    .filter(
      (
        item,
      ): item is {
        line: string;
        path: string;
        snippet: string;
      } => item !== null,
    );
}

function formatIssueInvestigationAnswer(goal: string, toolRuns: ToolRun[]) {
  const latestToolRun = toolRuns.at(-1);

  if (!latestToolRun || !latestToolRun.result.ok) {
    return null;
  }

  if (latestToolRun.name !== "read_file" && latestToolRun.name !== "search_text") {
    return null;
  }

  const latestIssuePlanIndex = findLatestIssuePlanIndex(toolRuns);
  if (latestIssuePlanIndex === -1 || latestIssuePlanIndex >= toolRuns.length - 1) {
    return null;
  }

  const issuePlan = extractIssuePlanFromGitInspectReport(
    toolRuns[latestIssuePlanIndex]?.result.content ?? "",
  );

  if (!issuePlan) {
    return null;
  }

  const issueGoal = extractIssueGoalFromPlan(issuePlan);
  const isChinese = taskLooksChinese(goal);

  if (latestToolRun.name === "read_file") {
    const targetPath = getToolPathReference(latestToolRun.input) ?? "(unknown file)";
    const preview = buildPreviewText(latestToolRun.result.content, 12, 900);

    return isChinese
      ? [
          "第一步调查结果：",
          `- 这个 issue 想解决：${issueGoal}`,
          `- 当前优先怀疑位置：${targetPath}`,
          "- 为什么先看这里：这份施工单已经把它列成了候选文件，所以先确认这里是不是问题发生点。",
          "- 代码预览：",
          preview,
          "建议下一步：",
          `- 继续围绕 ${targetPath} 里和 issue 相关的函数、条件分支或渲染位置缩小范围。`,
          "- 确认这是不是最小改动点后，再决定用 replace_text 还是 write_file 准备改动草稿。",
          "验证提醒：",
          "- 保留 issue 里的复现方式，改完后走同一遍检查。",
          "- 最后跑一次 npm run build。",
        ].join("\n")
      : [
          "First investigation result:",
          `- Issue goal: ${issueGoal}`,
          `- Current likely edit target: ${targetPath}`,
          "- Why this file first: the execution plan named it as a likely file, so this is the safest first inspection point.",
          "- Code preview:",
          preview,
          "Recommended next step:",
          `- Narrow the scope inside ${targetPath} to the specific function, branch, or render path tied to the issue.`,
          "- Once the smallest edit point is clear, choose replace_text or write_file for the draft.",
          "Validation reminder:",
          "- Re-run the same issue scenario after the change.",
          "- Run npm run build at the end.",
        ].join("\n");
  }

  const matches = parseSearchResultMatches(latestToolRun.result.content);
  const topMatches = matches.slice(0, 3);
  const firstMatch = topMatches[0];
  const searchedKeyword =
    typeof latestToolRun.input === "string"
      ? latestToolRun.input
      : getStringArg(latestToolRun.input, "query") || "(unknown keyword)";
  const preview =
    topMatches.length > 0
      ? topMatches
          .map(
            (match) => `- ${match.path}:${match.line}: ${match.snippet}`,
          )
          .join("\n")
      : latestToolRun.result.content;

  return isChinese
    ? [
        "第一步调查结果：",
        `- 这个 issue 想解决：${issueGoal}`,
        `- 当前优先搜索词：${searchedKeyword}`,
        firstMatch
          ? `- 当前更像改动入口的位置：${firstMatch.path}:${firstMatch.line}`
          : "- 还没有找到明确的改动入口。",
        "- 为什么先看这里：施工单没有点名具体文件，所以先用关键词在代码里找落点。",
        "- 搜索命中预览：",
        preview,
        "建议下一步：",
        firstMatch
          ? `- 先读 ${firstMatch.path}，确认这段命中是不是和 issue 描述的行为直接相关。`
          : "- 换一个更具体的关键词，再搜一次。",
        "- 定位到真正相关的文件后，再决定最小改动点。",
        "验证提醒：",
        "- 保留 issue 里的复现方式，改完后走同一遍检查。",
        "- 最后跑一次 npm run build。",
      ].join("\n")
    : [
        "First investigation result:",
        `- Issue goal: ${issueGoal}`,
        `- Current search keyword: ${searchedKeyword}`,
        firstMatch
          ? `- Current likely entry point: ${firstMatch.path}:${firstMatch.line}`
          : "- No clear edit entry point has been found yet.",
        "- Why start here: the plan did not name one exact file, so the safest first move is keyword search.",
        "- Search preview:",
        preview,
        "Recommended next step:",
        firstMatch
          ? `- Read ${firstMatch.path} next and confirm whether that hit is directly tied to the issue behavior.`
          : "- Try a more specific search keyword and search again.",
        "- Once the real file is confirmed, narrow to the smallest edit point.",
        "Validation reminder:",
        "- Re-run the same issue scenario after the change.",
        "- Run npm run build at the end.",
      ].join("\n");
}

function taskLooksChinese(text: string) {
  return /[\u4e00-\u9fff]/u.test(text);
}

function extractUrlFromTask(task: string) {
  const match = task.match(/https?:\/\/[^\s)>"']+|www\.[^\s)>"']+/i);
  return match?.[0]?.trim() ?? null;
}

function cleanClickTargetLabel(rawLabel: string) {
  return rawLabel
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveClickSelectorFromTask(task: string) {
  if (/\bclick\s+the\s+first\s+link\b/i.test(task) || /点击第一个链接/.test(task)) {
    return "a";
  }

  if (/\bclick\s+the\s+first\s+button\b/i.test(task) || /点击第一个按钮/.test(task)) {
    return "button";
  }

  const englishLinkMatch = task.match(/\bclick\s+(?:the\s+)?(.+?)\s+link\b/i);
  if (englishLinkMatch?.[1]) {
    const label = cleanClickTargetLabel(englishLinkMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const englishButtonMatch = task.match(/\bclick\s+(?:the\s+)?(.+?)\s+button\b/i);
  if (englishButtonMatch?.[1]) {
    const label = cleanClickTargetLabel(englishButtonMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const chineseLinkMatch = task.match(/点击(.+?)链接/);
  if (chineseLinkMatch?.[1]) {
    const label = cleanClickTargetLabel(chineseLinkMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const chineseButtonMatch = task.match(/点击(.+?)按钮/);
  if (chineseButtonMatch?.[1]) {
    const label = cleanClickTargetLabel(chineseButtonMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  return null;
}

function deriveMaxCharsFromTask(task: string) {
  const englishMatch = task.match(
    /\b(?:around|about|roughly|only|just)?\s*(\d{2,4})\s*(?:characters|character|chars)\b/i,
  );
  if (englishMatch?.[1]) {
    return Number(englishMatch[1]);
  }

  const chineseMatch = task.match(/(\d{2,4})\s*字/);
  if (chineseMatch?.[1]) {
    return Number(chineseMatch[1]);
  }

  return null;
}

function deriveDirectClickToolCall(task: string): PlannedToolCall | null {
  const url = extractUrlFromTask(task);
  const selector = deriveClickSelectorFromTask(task);
  const maxChars = deriveMaxCharsFromTask(task);

  if (!url || !selector) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "click_page",
    input:
      maxChars === null
        ? {
            url,
            selector,
          }
        : {
            url,
            selector,
            max_chars: maxChars,
          },
  };
}

function deriveDirectSafeCommandToolCall(task: string): DirectToolPlan | null {
  const cleanTask = task.trim();

  const asksForGitStatus =
    /\bgit\s+status\b/i.test(cleanTask) ||
    /(仓库状态|git状态|当前状态|工作区状态)/.test(cleanTask);

  if (asksForGitStatus) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "git",
        args: ["status"],
      },
    };
  }

  const asksForBuild =
    /\bnpm\s+run\s+build\b/i.test(cleanTask) ||
    /\bbuild\b/i.test(cleanTask) ||
    /(构建|编译|跑一下构建|构建检查|验证构建|检查能不能构建)/.test(cleanTask);

  if (asksForBuild) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "npm",
        args: ["run", "build"],
      },
    };
  }

  const asksForTest =
    /\bnpm\s+test\b/i.test(cleanTask) ||
    /\btest\b/i.test(cleanTask) ||
    /(测试|跑测试|执行测试|验证测试|检查测试)/.test(cleanTask);

  if (asksForTest) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "npm",
        args: ["test"],
      },
    };
  }

  return null;
}

function deriveDirectGitInspectToolCall(task: string): DirectToolPlan | null {
  const cleanTask = task.trim();
  const asksForIssuePlan =
    /(issue\s*(计划|execution\s*plan)|执行计划|改代码计划)/i.test(cleanTask);
  const issueDetailMatch =
    cleanTask.match(/\bissue\s+#?(\d+)\b/i) ||
    cleanTask.match(/issue\s*详情\s*#?(\d+)/i) ||
    cleanTask.match(/第\s*(\d+)\s*个\s*issue/i) ||
    cleanTask.match(/issue\s*(\d+)/i);

  if (asksForIssuePlan && issueDetailMatch?.[1]) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_plan",
        issue_number: Number(issueDetailMatch[1]),
      },
    };
  }

  if (issueDetailMatch?.[1]) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_detail",
        issue_number: Number(issueDetailMatch[1]),
      },
    };
  }

  const asksForIssueList =
    /\bissues?\b/i.test(cleanTask) ||
    /(issue 列表|issues 列表|当前 issue|仓库 issue|待办单|问题列表)/i.test(
      cleanTask,
    );

  if (asksForIssueList) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_list",
      },
    };
  }

  const asksForRepoInfo =
    /\brepo\b/i.test(cleanTask) ||
    /(仓库信息|当前仓库|repo info|repository info|仓库详情|github 仓库信息)/i.test(
      cleanTask,
    );

  if (asksForRepoInfo) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "repo_info",
      },
    };
  }

  const asksForPrDraft =
    /\bpr\b/i.test(cleanTask) ||
    /(pr 草稿|pull request|拉取请求|合并请求|pr 文案|pr draft|帮我写 pr)/i.test(
      cleanTask,
    );

  if (asksForPrDraft) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "pr_draft",
      },
    };
  }

  const asksForCommitMessage =
    /\bcommit\s+message\b/i.test(cleanTask) ||
    /(提交说明|提交信息|commit 文案|commit message|帮我写提交信息|帮我写 commit)/i.test(
      cleanTask,
    );

  if (asksForCommitMessage) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "commit_message",
      },
    };
  }

  const asksForGithubEnv =
    /\bgh\b/i.test(cleanTask) ||
    /(github|remote|origin).{0,12}(连接|连上|环境|状态|检查|配置)/i.test(cleanTask) ||
    /(有没有\s*remote|有没有\s*github\s*remote|能不能用\s*gh|github\s*登录|gh\s*登录)/i.test(
      cleanTask,
    );

  if (asksForGithubEnv) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "github_env",
      },
    };
  }

  const asksForGitSummary =
    /(?:git|change|diff|status)\s+summary/i.test(cleanTask) ||
    /(变更总结|改动总结|总结改动|总结变更|git总结|git 摘要|change summary)/i.test(
      cleanTask,
    );

  if (asksForGitSummary) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "summary",
      },
    };
  }

  const asksForGitDiff =
    /\bgit\s+diff\b/i.test(cleanTask) ||
    /(git\s*diff|仓库差异|改动差异|变更差异|查看差异|看看差异)/i.test(cleanTask);

  if (asksForGitDiff) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "diff",
      },
    };
  }

  const asksForGitStatus =
    /\bgit\s+status\b/i.test(cleanTask) ||
    /(git\s*状态|仓库状态|工作区状态|改动状态|查看状态|看看状态)/i.test(cleanTask);

  if (asksForGitStatus) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "status",
      },
    };
  }

  const asksWhetherGitRepo =
    /\bgit\s+(repo|repository)\b/i.test(cleanTask) ||
    /(是不是|是否|算不算|当前目录|这个目录|这个项目).{0,12}(git\s*仓库|git\s*repo|git\s*repository)/i.test(
      cleanTask,
    ) ||
    /(git\s*仓库|git\s*repo|git\s*repository).{0,12}(吗|没有|情况|状态|检查)/i.test(
      cleanTask,
    );

  if (!asksWhetherGitRepo) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "git_inspect",
    input: {
      action: "check_repo",
    },
  };
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

function formatReadPageAnswer(goal: string, content: string) {
  const parsed = parseReadPageToolContent(content);

  if (!parsed) {
    return null;
  }

  if (taskLooksChinese(goal)) {
    return [
      `最终网址：${parsed.finalUrl}`,
      `页面标题：${parsed.pageTitle}`,
      `正文摘录：${parsed.visibleTextSample}`,
    ].join("\n");
  }

  return [
    `Final URL: ${parsed.finalUrl}`,
    `Page title: ${parsed.pageTitle}`,
    `Visible text sample: ${parsed.visibleTextSample}`,
  ].join("\n");
}

function formatClickPageAnswer(goal: string, content: string) {
  const parsed = parseClickPageToolContent(content);

  if (!parsed) {
    return null;
  }

  if (taskLooksChinese(goal)) {
    return [
      `点击目标：${parsed.clickedSelector}`,
      `最终网址：${parsed.finalUrl}`,
      `页面标题：${parsed.pageTitle}`,
      `正文摘录：${parsed.visibleTextSample}`,
    ].join("\n");
  }

  return [
    `Clicked selector: ${parsed.clickedSelector}`,
    `Final URL: ${parsed.finalUrl}`,
    `Page title: ${parsed.pageTitle}`,
    `Visible text sample: ${parsed.visibleTextSample}`,
  ].join("\n");
}

function normalizeToolInput(toolName: string, rawInput: ToolCallArgs, task: string) {
  if (toolName === "list_files") {
    return {
      path: getStringArg(rawInput, "path") || ".",
    };
  }

  if (toolName === "read_file") {
    const path = getStringArg(rawInput, "path");
    return path ? { path } : null;
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
      query: deriveFocusedWebSearchQuery(query || task),
    };
  }

  return rawInput;
}

function derivePastedIssuePlanToolCall(task: string): DirectToolPlan | null {
  const cleanTask = task.trim();
  const hasPastedIssueText =
    /(?:^|\n)\s*title\s*:/i.test(cleanTask) &&
    /(?:^|\n)\s*body\s*:/i.test(cleanTask);
  const mentionsIssue = /\bissue\b/i.test(cleanTask);

  if (!hasPastedIssueText || !mentionsIssue) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "git_inspect",
    input: {
      action: "issue_plan",
      issue_text: cleanTask,
    },
  };
}

function stripLeadingMatch(text: string, patterns: RegExp[]) {
  let nextText = text.trim();

  for (const pattern of patterns) {
    const updated = nextText.replace(pattern, "").trim();
    if (updated !== nextText) {
      nextText = updated;
    }
  }

  return nextText;
}

function stripTrailingMatch(text: string, patterns: RegExp[]) {
  let nextText = text.trim();

  for (const pattern of patterns) {
    const updated = nextText.replace(pattern, "").trim();
    if (updated !== nextText) {
      nextText = updated;
    }
  }

  return nextText;
}

function deriveWebSearchQueryFromTask(task: string) {
  const taggedQuery = parseTagBlock(task, "query");
  if (taggedQuery) {
    return taggedQuery;
  }

  let query = task.trim();

  query = stripLeadingMatch(query, [
    /^(?:请帮我|帮我|请你|请|麻烦你|麻烦)\s*/u,
    /^(?:在网上|上网|在线)\s*/u,
    /^(?:搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查找|查询|找一下)\s*/u,
    /^(?:关于|一下)\s*/u,
    /^(?:please\s+)?(?:search|look up|find)\s+(?:for\s+)?/iu,
  ]);

  query = stripTrailingMatch(query, [
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:并|然后|再)?\s*(?:把|将)?\s*(?:网页)?标题和链接(?:告诉我|给我|发我)?\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:只要|只需要)?\s*(?:网页)?标题和链接\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:告诉我|给我|发我|列出来)\s*$/u,
    /\s*(?:and\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?title(?:s)?\s+and\s+link(?:s)?\s*$/iu,
  ]);

  query = query.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, "").trim();

  return query || task.trim();
}

function hasWhoSearchIntent(text: string) {
  return /(?:\u662f\u8c01|\u4ec0\u4e48\u4eba|\u8c01\u554a|\u8c01\u5440)/u.test(text);
}

function hasWhenSearchIntent(text: string) {
  return /(?:\u4ec0\u4e48\u65f6\u5019|\u5565\u65f6\u5019|\u4f55\u65f6|\u51e0\u70b9|\u51e0\u53f7|\u54ea\u5929|when|what\s+time|what\s+date)/iu.test(
    text,
  );
}

function hasEndSearchIntent(text: string) {
  return /(?:\u7ed3\u675f|\u622a\u6b62|end|ending|ends)/iu.test(text);
}

function hasStartSearchIntent(text: string) {
  return /(?:\u5f00\u59cb|\u5f00\u5e55|start|begin|opening)/iu.test(text);
}

function collapseSearchTerms(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function appendSearchTerms(query: string, suffix: string) {
  const normalizedQuery = collapseSearchTerms(query);

  if (!normalizedQuery) {
    return suffix;
  }

  if (normalizedQuery.toLowerCase().includes(suffix.toLowerCase())) {
    return normalizedQuery;
  }

  return `${normalizedQuery} ${suffix}`;
}

function deriveFocusedWebSearchQuery(task: string) {
  const taggedQuery = parseTagBlock(task, "query");
  if (taggedQuery) {
    return taggedQuery;
  }

  const originalTask = task.trim();
  const asksWho = hasWhoSearchIntent(originalTask);
  const asksWhen = hasWhenSearchIntent(originalTask);
  const asksEnd = hasEndSearchIntent(originalTask);
  const asksStart = hasStartSearchIntent(originalTask);

  let query = originalTask;

  query = stripLeadingMatch(query, [
    /^(?:\u8bf7\u5e2e\u6211|\u5e2e\u6211|\u8bf7\u4f60|\u8bf7|\u9ebb\u70e6\u4f60|\u9ebb\u70e6)\s*/u,
    /^(?:\u5728\u7f51\u4e0a|\u4e0a\u7f51|\u5728\u7ebf)\s*/u,
    /^(?:\u641c\u7d22\u4e00\u4e0b|\u641c\u7d22|\u641c\u4e00\u4e0b|\u641c\u4e00\u641c|\u641c\u641c|\u67e5\u4e00\u4e0b|\u67e5\u4e00\u67e5|\u67e5\u67e5|\u67e5\u627e|\u67e5\u8be2|\u627e\u4e00\u4e0b)\s*/u,
    /^(?:\u5173\u4e8e|\u4e00\u4e0b)\s*/u,
    /^(?:please\s+)?(?:search|look up|find)\s+(?:for\s+)?/iu,
  ]);

  query = stripTrailingMatch(query, [
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u5e76|\u7136\u540e|\u518d)?\s*(?:\u628a|\u5c06)?\s*(?:\u7f51\u9875)?\u6807\u9898\u548c\u94fe\u63a5(?:\u544a\u8bc9\u6211|\u7ed9\u6211|\u53d1\u6211)?\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u53ea\u8981|\u53ea\u9700\u8981)?\s*(?:\u7f51\u9875)?\u6807\u9898\u548c\u94fe\u63a5\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u544a\u8bc9\u6211|\u7ed9\u6211|\u53d1\u6211|\u5217\u51fa\u6765)\s*$/u,
    /\s*(?:and\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?title(?:s)?\s+and\s+link(?:s)?\s*$/iu,
  ]);

  query = collapseSearchTerms(
    query
      .replace(/[\u3002\uFF0C\uFF01\uFF1F,!.?]+/gu, " ")
      .replace(/([\p{Script=Han}])\u5728(?=[A-Za-z0-9])/gu, "$1 ")
      .replace(/(?<=[\p{Script=Han}])(?=[A-Za-z0-9])/gu, " ")
      .replace(/(?<=[A-Za-z0-9])(?=[\p{Script=Han}])/gu, " ")
      .replace(
        /(?:\u662f\u8c01|\u4ec0\u4e48\u4eba|\u8c01\u554a|\u8c01\u5440|\u4ec0\u4e48\u65f6\u5019|\u5565\u65f6\u5019|\u4f55\u65f6|\u51e0\u70b9|\u51e0\u53f7|\u54ea\u5929|\u4ec0\u4e48\u65f6\u95f4|\u7ed3\u675f|\u622a\u6b62|\u5f00\u59cb|\u5f00\u5e55)/gu,
        " ",
      )
      .replace(/\b(?:who|when|what\s+time|what\s+date)\b/giu, " ")
      .replace(/[\u201c\u201d"'`\u2018\u2019]+/gu, " "),
  );

  if (asksWho) {
    query = appendSearchTerms(query, "\u4eba\u7269 \u7b80\u4ecb");
  } else if (asksWhen && asksEnd) {
    query = appendSearchTerms(query, "\u7ed3\u675f\u65f6\u95f4");
  } else if (asksWhen && asksStart) {
    query = appendSearchTerms(query, "\u5f00\u59cb\u65f6\u95f4");
  } else if (asksWhen) {
    query = appendSearchTerms(query, "\u65f6\u95f4 \u65e5\u671f");
  }

  return query || originalTask;
}

function parseWriteCommand(task: string): WriteCommand {
  const trimmedTask = task.trim();
  const approveMatch = trimmedTask.match(/^APPROVE_WRITE(?:\s+(\S+))?$/i);
  if (approveMatch) {
    return {
      type: "approve",
      draftId: approveMatch[1] ?? null,
    };
  }

  const cancelMatch = trimmedTask.match(/^CANCEL_WRITE(?:\s+(\S+))?$/i);
  if (cancelMatch) {
    return {
      type: "cancel",
      draftId: cancelMatch[1] ?? null,
    };
  }

  return null;
}

type DraftLifecycleAction = "approve" | "cancel" | "continue";

function parseDraftLifecycleAction(task: string): DraftLifecycleAction | null {
  const trimmedTask = task.trim();

  if (!trimmedTask) {
    return null;
  }

  if (
    /^(?:please\s+)?approve(?:\s|$)/i.test(trimmedTask) ||
    /^(批准|确认写入|批准它|批准这个|批准刚才那个|确认这个draft|确认这个草稿)/.test(
      trimmedTask,
    )
  ) {
    return "approve";
  }

  if (
    /^(?:please\s+)?cancel(?:\s|$)/i.test(trimmedTask) ||
    /^(取消|丢弃|丢掉|放弃|不要写了|取消它|取消这个|取消刚才那个)/.test(
      trimmedTask,
    )
  ) {
    return "cancel";
  }

  if (
    /^(?:please\s+)?continue(?:\s|$)/i.test(trimmedTask) ||
    /^(继续|接着|继续上一步|继续刚才那个)/.test(trimmedTask)
  ) {
    return "continue";
  }

  return null;
}

function isAmbiguousDraftConfirmation(task: string) {
  const trimmedTask = task.trim().toLowerCase();

  return (
    /^(ok|okay|yes|yep|go ahead|looks good|approved?)$/.test(trimmedTask) ||
    /^(?:\u901a\u8fc7|\u597d|\u884c|\u53ef\u4ee5|\u786e\u8ba4|\u6ca1\u95ee\u9898)$/.test(
      task.trim(),
    )
  );
}

async function handleWriteApproval(task: string): Promise<AgentResponse | null> {
  const command = parseWriteCommand(task);

  if (!command) {
    return null;
  }

  if (!command.draftId) {
    const commandName =
      command.type === "approve" ? APPROVE_WRITE_COMMAND : CANCEL_WRITE_COMMAND;

      return {
        message: createMessage(
          [
            "A draft id is required.",
            `Use the exact format: ${commandName} draft-123`,
          ].join("\n"),
        ),
        sessionContext: {},
        steps: [
          createStep(
            "perceive",
          "Perceive",
          "Read a write confirmation command from the user.",
        ),
        createStep(
          "think",
          "Think",
          "Check whether the command includes a draft id.",
        ),
        createStep(
          "act",
          "Act",
          "Stop here because the command was missing its draft id.",
        ),
      ],
    };
  }

  if (command.type === "approve") {
    const pendingDraft = getPendingWriteDraft();

    if (!pendingDraft) {
      return {
        message: createMessage("There is no pending write draft to approve."),
        sessionContext: {},
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read the approval command from the user.",
          ),
          createStep(
            "think",
            "Think",
            "Check whether a pending write draft exists.",
          ),
          createStep(
            "act",
            "Act",
            "No draft was waiting, so nothing was written.",
          ),
        ],
      };
    }

    if (pendingDraft.id !== command.draftId) {
      return {
        message: createMessage(
          [
            "The draft id did not match the current pending draft.",
            `Requested id: ${command.draftId}`,
            `Current pending id: ${pendingDraft.id}`,
          ].join("\n"),
        ),
        sessionContext: {
          pendingDraft,
        },
        steps: [
          createStep(
            "perceive",
            "Perceive",
            `Read the approval command for draft "${command.draftId}".`,
          ),
          createStep(
            "think",
            "Think",
            `Compare the requested id with the current pending draft id "${pendingDraft.id}".`,
          ),
          createStep(
            "act",
            "Act",
            "Refuse the write because the draft id did not match.",
          ),
        ],
      };
    }

    const appliedDraft = await applyPendingWriteDraft();

    return {
      message: createMessage(
        [
          "Write approved and saved.",
          `Draft id: ${pendingDraft.id}`,
          `Target path: ${pendingDraft.path}`,
          "The draft has been written to disk.",
        ].join("\n"),
      ),
      sessionContext: {
        lastToolInput: pendingDraft.path,
        lastToolName: "write_file",
        pendingDraft: null,
      },
      steps: [
        createStep(
          "perceive",
          "Perceive",
          `Read the exact approval command "${APPROVE_WRITE_COMMAND} ${pendingDraft.id}".`,
        ),
        createStep(
          "think",
          "Think",
          `Confirm that draft "${pendingDraft.id}" exists for "${pendingDraft.path}".`,
        ),
        createStep(
          "act",
          "Act",
          `Write approved draft "${appliedDraft?.id ?? pendingDraft.id}" to "${appliedDraft?.path ?? pendingDraft.path}".`,
        ),
      ],
    };
  }

  if (command.type === "cancel") {
    const pendingDraft = getPendingWriteDraft();

    if (!pendingDraft) {
      return {
        message: createMessage("There is no pending write draft to discard."),
        sessionContext: {},
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read the cancel command from the user.",
          ),
          createStep(
            "think",
            "Think",
            "Check whether there is a pending draft to discard.",
          ),
          createStep(
            "act",
            "Act",
            "Nothing was waiting, so nothing was cleared.",
          ),
        ],
      };
    }

    if (pendingDraft.id !== command.draftId) {
      return {
        message: createMessage(
          [
            "The draft id did not match the current pending draft.",
            `Requested id: ${command.draftId}`,
            `Current pending id: ${pendingDraft.id}`,
          ].join("\n"),
        ),
        sessionContext: {
          pendingDraft,
        },
        steps: [
          createStep(
            "perceive",
            "Perceive",
            `Read the cancel command for draft "${command.draftId}".`,
          ),
          createStep(
            "think",
            "Think",
            `Compare the requested id with the current pending draft id "${pendingDraft.id}".`,
          ),
          createStep(
            "act",
            "Act",
            "Keep the draft because the cancel id did not match.",
          ),
        ],
      };
    }

    clearPendingWriteDraft();

    return {
      message: createMessage(
        [
          "Draft discarded.",
          `Draft id: ${pendingDraft.id}`,
          `Target path: ${pendingDraft.path}`,
        ].join("\n"),
      ),
      sessionContext: {
        lastToolInput: pendingDraft.path,
        lastToolName: "write_file",
        pendingDraft: null,
      },
      steps: [
        createStep(
          "perceive",
          "Perceive",
          `Read the exact cancel command "${CANCEL_WRITE_COMMAND} ${pendingDraft.id}".`,
        ),
        createStep(
          "think",
          "Think",
          `Confirm that draft "${pendingDraft.id}" is the one waiting to be discarded.`,
        ),
        createStep(
          "act",
          "Act",
          `Clear draft "${pendingDraft.id}" for "${pendingDraft.path}" without writing it.`,
        ),
      ],
    };
  }

  return null;
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
    /(修改|编辑|更新|改|追加|替换|重写|删除|增加)/.test(task)
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

async function runToolCall(
  toolName: string,
  toolInput: ToolExecutionInput,
  toolCallId: string,
  assistantMessage: LlmMessage,
): Promise<ToolRun> {
  const tool = getTool(toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" is not registered.`);
  }

  const result = await tool.execute(toolInput);
  const inputText = formatToolExecutionInput(toolInput);

  return {
    assistantMessage,
    name: toolName,
    input: toolInput,
    inputText,
    result,
    toolCallId,
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

  const context: AgentContext = {
    cleanTask: task.trim(),
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    recentConversation: normalizeConversationHistory(messages, task),
    sessionContext: effectiveSessionContext,
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
              ? effectiveSessionContext
              : buildNextSessionContext(effectiveSessionContext, toolRuns),
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
          sessionContext: buildNextSessionContext(effectiveSessionContext, toolRuns),
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
          sessionContext: buildNextSessionContext(effectiveSessionContext, toolRuns),
          steps,
        },
        false,
        toolRuns.length,
      );
    }
  }
}
