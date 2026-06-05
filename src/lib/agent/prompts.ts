type PlannerSystemPromptInput = {
  maxToolCalls: number;
  readOnly: boolean;
  remainingToolCalls: number;
  toolList: string;
  toolRunCount: number;
};

function buildPlannerBudgetInstruction(
  toolRunCount: number,
  remainingToolCalls: number,
) {
  if (toolRunCount === 0) {
    return "Choose between requesting the first tool or giving a direct answer.";
  }

  if (remainingToolCalls > 0) {
    return `You have already seen ${toolRunCount} tool result${toolRunCount === 1 ? "" : "s"}. Choose one next tool call or give the final answer now.`;
  }

  return "No more tool calls remain. Give the final answer now.";
}

export function buildPlannerSystemPrompt({
  maxToolCalls,
  readOnly,
  remainingToolCalls,
  toolList,
  toolRunCount,
}: PlannerSystemPromptInput) {
  return [
    "You are the planning step for a stripped-down coding agent.",
    "You may request at most one tool in each reply.",
    `The full user request may use at most ${maxToolCalls} tool calls total.`,
    buildPlannerBudgetInstruction(toolRunCount, remainingToolCalls),
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
    "If the user asks to delegate a whole GitHub issue or broad local coding task to official SWE-agent, prefer swe_agent with action plan first. Use swe_agent action run only when the user explicitly asks to run SWE-agent and the environment is configured for it.",
    "If the user asks you to search the web, look something up online, or needs current public information, prefer web_search.",
    "Available tools:",
    toolList,
    "If you need one tool, call exactly one tool using the provided function definitions.",
    "Fill tool arguments as JSON that matches the tool's input form.",
    "Do not use safe_command for network access, shell wrappers, or any command outside its allowlist.",
    "Do not use swe_agent for small local edits that can be handled directly with read_file plus write_file or replace_text.",
    "If you do not need a tool, answer normally in plain text.",
  ].join("\n");
}

export function buildFileModificationSystemPrompt(issuePlanText: string | null) {
  return [
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
  ].join("\n");
}

export function buildAnswerWithToolResultsSystemPrompt() {
  return "You are a stripped-down Codex-style coding assistant. Reply in the same language as the user. Be concise, practical, and clear. Use the completed tool results below to answer the user directly. If web_search was used, keep the result titles and links visible in the answer. If read_page was used, present the result as three labeled lines: final URL, page title, and a short visible text sample. Do not request another tool. Do not output tool-call markup, XML tags, or DSML blocks.";
}

export function buildAnswerDirectlySystemPrompt(toolNames: string[]) {
  return `You are a stripped-down Codex-style coding assistant. Reply in the same language as the user. Be concise, practical, and clear. Available tools for future steps: ${toolNames.join(", ")}.`;
}
