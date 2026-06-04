import { existsSync } from "node:fs";
import path from "node:path";
import type { PlannedToolCall } from "@/lib/agent/model-client";
import {
  getStringArg,
  getToolPathReference,
} from "@/lib/agent/tool-args";
import {
  createSyntheticToolCallId,
  type ToolRun,
} from "@/lib/agent/tool-run-types";
import { getWorkspaceRoot } from "@/lib/tools/workspace-path";

function taskLooksChinese(text: string) {
  return /[\u4e00-\u9fff]/u.test(text);
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

export function parseGitInspectAction(content: string) {
  const match = content.match(/^action:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function extractIssueDetailFromGitInspectReport(content: string) {
  return parseReportSection(content, "issue_detail", ["issue_list"]);
}

export function extractIssuePlanFromGitInspectReport(content: string) {
  return parseReportSection(content, "issue_plan", ["repo_info"]);
}

function isStructuredIssueDetail(text: string) {
  return /^#\d+\s+\[[A-Z]+\]\s+/m.test(text);
}

export function deriveIssuePlanToolCallFromToolRun(
  toolRun: ToolRun,
): PlannedToolCall | null {
  if (toolRun.name !== "git_inspect" || !toolRun.result.ok) {
    return null;
  }

  if (parseGitInspectAction(toolRun.result.content) !== "issue_detail") {
    return null;
  }

  const issueDetail = extractIssueDetailFromGitInspectReport(
    toolRun.result.content,
  );

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

export function deriveIssueInvestigationToolCallFromToolRun(
  toolRun: ToolRun,
): PlannedToolCall | null {
  if (toolRun.name !== "git_inspect" || !toolRun.result.ok) {
    return null;
  }

  if (parseGitInspectAction(toolRun.result.content) !== "issue_plan") {
    return null;
  }

  const issuePlan = extractIssuePlanFromGitInspectReport(
    toolRun.result.content,
  );

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

export function getLatestIssuePlanText(toolRuns: ToolRun[]) {
  const latestIssuePlanIndex = findLatestIssuePlanIndex(toolRuns);

  if (latestIssuePlanIndex === -1) {
    return null;
  }

  return extractIssuePlanFromGitInspectReport(
    toolRuns[latestIssuePlanIndex]?.result.content ?? "",
  );
}

export function isIssueDrivenReadForDraft(toolRuns: ToolRun[]) {
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

export function formatIssueInvestigationAnswer(
  goal: string,
  toolRuns: ToolRun[],
) {
  const latestToolRun = toolRuns.at(-1);

  if (!latestToolRun || !latestToolRun.result.ok) {
    return null;
  }

  if (latestToolRun.name !== "read_file" && latestToolRun.name !== "search_text") {
    return null;
  }

  const issuePlan = getLatestIssuePlanText(toolRuns);
  const latestIssuePlanIndex = findLatestIssuePlanIndex(toolRuns);
  if (!issuePlan || latestIssuePlanIndex >= toolRuns.length - 1) {
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
          "- 为什么先看这里：执行计划把它列成候选文件，所以先确认这里是不是问题发生点。",
          "- 代码预览：",
          preview,
          "建议下一步：",
          `- 继续围绕 ${targetPath} 里和 issue 相关的函数、条件分支或渲染位置缩小范围。`,
          "- 确认最小改动点后，再决定用 replace_text 还是 write_file 准备改动草稿。",
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
          .map((match) => `- ${match.path}:${match.line}: ${match.snippet}`)
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
        "- 为什么先看这里：执行计划没有点名具体文件，所以先用关键词在代码里找落点。",
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
