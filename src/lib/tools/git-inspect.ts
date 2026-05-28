import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AgentTool,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { getWorkspaceRoot } from "@/lib/tools/workspace-path";

const execFileAsync = promisify(execFile);
const MAX_DIFF_PREVIEW_LENGTH = 12_000;
const GH_CLI_EXECUTABLE = "C:\\Program Files\\GitHub CLI\\gh.exe";

type GitInspectAction =
  | "check_repo"
  | "status"
  | "diff"
  | "summary"
  | "github_env"
  | "commit_message"
  | "pr_draft"
  | "repo_info"
  | "issue_list"
  | "issue_detail"
  | "issue_plan";

type ParsedGitInspectInput =
  | {
      action: GitInspectAction;
      ok: true;
    }
  | {
      message: string;
      ok: false;
    };

type GitInspectReport = {
  action: GitInspectAction;
  branch: string | null;
  commitMessageSuggestion: string | null;
  diffPreview: string | null;
  ghAuthStatus: string | null;
  ghCliAvailable: boolean | null;
  githubReadinessLevel: string | null;
  githubReadinessMissing: string[];
  githubRemoteNames: string[];
  issueDetail: string | null;
  issueList: string | null;
  issuePlan: string | null;
  isGitRepository: boolean;
  message: string;
  prDraftSuggestion: string | null;
  repoInfo: string | null;
  remoteEntries: string[];
  repositoryRoot: string | null;
  summaryText: string | null;
  status: "success" | "failed" | "rejected";
  statusEntries: string[];
  workspaceRoot: string;
};

function createGitInspectReport(
  report: Omit<
    GitInspectReport,
    | "branch"
    | "commitMessageSuggestion"
    | "diffPreview"
    | "ghAuthStatus"
    | "ghCliAvailable"
    | "githubReadinessLevel"
    | "githubReadinessMissing"
    | "githubRemoteNames"
    | "issueDetail"
    | "issueList"
    | "issuePlan"
    | "remoteEntries"
    | "prDraftSuggestion"
    | "repoInfo"
    | "summaryText"
    | "statusEntries"
  > & {
    branch?: string | null;
    commitMessageSuggestion?: string | null;
    diffPreview?: string | null;
    ghAuthStatus?: string | null;
    ghCliAvailable?: boolean | null;
    githubReadinessLevel?: string | null;
    githubReadinessMissing?: string[];
    githubRemoteNames?: string[];
    issueDetail?: string | null;
    issueList?: string | null;
    issuePlan?: string | null;
    prDraftSuggestion?: string | null;
    repoInfo?: string | null;
    remoteEntries?: string[];
    summaryText?: string | null;
    statusEntries?: string[];
  },
): GitInspectReport {
  return {
    branch: report.branch ?? null,
    commitMessageSuggestion: report.commitMessageSuggestion ?? null,
    diffPreview: report.diffPreview ?? null,
    ghAuthStatus: report.ghAuthStatus ?? null,
    ghCliAvailable: report.ghCliAvailable ?? null,
    githubReadinessLevel: report.githubReadinessLevel ?? null,
    githubReadinessMissing: report.githubReadinessMissing ?? [],
    githubRemoteNames: report.githubRemoteNames ?? [],
    issueDetail: report.issueDetail ?? null,
    issueList: report.issueList ?? null,
    issuePlan: report.issuePlan ?? null,
    prDraftSuggestion: report.prDraftSuggestion ?? null,
    repoInfo: report.repoInfo ?? null,
    remoteEntries: report.remoteEntries ?? [],
    summaryText: report.summaryText ?? null,
    statusEntries: report.statusEntries ?? [],
    ...report,
  };
}

function formatGitInspectReport(report: GitInspectReport) {
  return [
    "tool: git_inspect",
    `status: ${report.status}`,
    `action: ${report.action}`,
    `is_git_repository: ${report.isGitRepository ? "yes" : "no"}`,
    `workspace_root: ${report.workspaceRoot}`,
    `repository_root: ${report.repositoryRoot ?? "(none)"}`,
    `branch: ${report.branch ?? "(none)"}`,
    "commit_message_suggestion:",
    report.commitMessageSuggestion ?? "(none)",
    `gh_cli_available: ${report.ghCliAvailable === null ? "(unknown)" : report.ghCliAvailable ? "yes" : "no"}`,
    `gh_auth_status: ${report.ghAuthStatus ?? "(none)"}`,
    `github_readiness_level: ${report.githubReadinessLevel ?? "(none)"}`,
    `github_remote_names: ${report.githubRemoteNames.length > 0 ? report.githubRemoteNames.join(", ") : "(none)"}`,
    "message:",
    report.message,
    "issue_detail:",
    report.issueDetail ?? "(none)",
    "issue_list:",
    report.issueList ?? "(none)",
    "issue_plan:",
    report.issuePlan ?? "(none)",
    "repo_info:",
    report.repoInfo ?? "(none)",
    "pr_draft_suggestion:",
    report.prDraftSuggestion ?? "(none)",
    "summary_text:",
    report.summaryText ?? "(none)",
    "github_readiness_missing:",
    report.githubReadinessMissing.length > 0
      ? report.githubReadinessMissing.join("\n")
      : "(none)",
    "remote_entries:",
    report.remoteEntries.length > 0 ? report.remoteEntries.join("\n") : "(none)",
    "status_entries:",
    report.statusEntries.length > 0 ? report.statusEntries.join("\n") : "(none)",
    "diff_preview:",
    report.diffPreview ?? "(none)",
  ].join("\n");
}

function parseGitInspectInput(input: ToolExecutionInput): ParsedGitInspectInput {
  if (typeof input === "string") {
    return {
      ok: false,
      message:
        'git_inspect expects object input like {"action":"check_repo"}, {"action":"status"}, {"action":"diff"}, {"action":"summary"}, {"action":"github_env"}, {"action":"commit_message"}, {"action":"pr_draft"}, {"action":"repo_info"}, {"action":"issue_list"}, {"action":"issue_detail","issue_number":123}, or {"action":"issue_plan","issue_text":"..."}; plain string input is not supported.',
    };
  }

  const action = typeof input.action === "string" ? input.action.trim() : "";

  if (
    action !== "check_repo" &&
    action !== "status" &&
    action !== "diff" &&
    action !== "summary" &&
    action !== "github_env" &&
    action !== "commit_message" &&
    action !== "pr_draft" &&
    action !== "repo_info" &&
    action !== "issue_list" &&
    action !== "issue_detail" &&
    action !== "issue_plan"
  ) {
    return {
      ok: false,
      message:
        'git_inspect currently allows only {"action":"check_repo"}, {"action":"status"}, {"action":"diff"}, {"action":"summary"}, {"action":"github_env"}, {"action":"commit_message"}, {"action":"pr_draft"}, {"action":"repo_info"}, {"action":"issue_list"}, {"action":"issue_detail"}, or {"action":"issue_plan"} as input.',
    };
  }

  if (action === "issue_detail") {
    const issueNumber = input.issue_number;

    if (
      typeof issueNumber !== "number" ||
      !Number.isFinite(issueNumber) ||
      issueNumber <= 0
    ) {
      return {
        ok: false,
        message:
          'git_inspect action "issue_detail" requires a positive numeric "issue_number".',
      };
    }
  }

  if (action === "issue_plan") {
    const issueText = typeof input.issue_text === "string" ? input.issue_text.trim() : "";
    const issueNumber = input.issue_number;

    const hasValidIssueNumber =
      typeof issueNumber === "number" && Number.isFinite(issueNumber) && issueNumber > 0;

    if (!issueText && !hasValidIssueNumber) {
      return {
        ok: false,
        message:
          'git_inspect action "issue_plan" requires either a non-empty "issue_text" string or a positive numeric "issue_number".',
      };
    }
  }

  return {
    ok: true,
    action,
  };
}

function isNotGitRepositoryError(error: unknown) {
  const message = String(
    (error as { message?: unknown })?.message ??
      (error as { stderr?: unknown })?.stderr ??
      "",
  ).toLowerCase();

  return message.includes("not a git repository");
}

function isCommandMissingError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT";
}

async function getRepositoryRoot(workspaceRoot: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );

  return stdout.trim() || workspaceRoot;
}

async function runCheckRepoAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "check_repo",
          isGitRepository: true,
          message: "The current workspace is inside a Git repository.",
          repositoryRoot,
          status: "success",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "check_repo",
            isGitRepository: false,
            message: "The current workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while checking the current workspace.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "check_repo",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

function parseBranchName(branchLine: string) {
  const cleaned = branchLine.replace(/^##\s*/, "").trim();

  if (!cleaned) {
    return null;
  }

  const noCommitsMatch = cleaned.match(/^No commits yet on\s+(.+)$/);
  if (noCommitsMatch?.[1]) {
    return noCommitsMatch[1].trim();
  }

  if (cleaned === "HEAD (no branch)") {
    return "detached HEAD";
  }

  return cleaned.split("...")[0]?.trim() || null;
}

function parseGitStatusOutput(stdout: string) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const branchLine = lines[0]?.startsWith("## ") ? lines[0] : "";

  return {
    branch: branchLine ? parseBranchName(branchLine) : null,
    statusEntries: branchLine ? lines.slice(1) : lines,
  };
}

function trimDiffPreview(diffText: string) {
  if (diffText.length <= MAX_DIFF_PREVIEW_LENGTH) {
    return diffText;
  }

  return `${diffText.slice(0, MAX_DIFF_PREVIEW_LENGTH)}\n[diff preview truncated]`;
}

type ParsedRemoteEntry = {
  name: string;
  url: string;
};

function parseGitRemoteEntries(stdout: string) {
  const remoteEntries = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsedEntries: ParsedRemoteEntry[] = [];

  for (const entry of remoteEntries) {
    const match = entry.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);

    if (!match) {
      continue;
    }

    parsedEntries.push({
      name: match[1],
      url: match[2],
    });
  }

  return {
    parsedEntries,
    remoteEntries,
  };
}

function isGithubRemoteUrl(url: string) {
  return url.includes("github.com/");
}

function buildGithubRemoteNames(parsedEntries: ParsedRemoteEntry[]) {
  return [...new Set(parsedEntries.filter((entry) => isGithubRemoteUrl(entry.url)).map((entry) => entry.name))];
}

async function checkGhCliAvailability() {
  try {
    const { stdout, stderr } = await execFileAsync(GH_CLI_EXECUTABLE, ["--version"], {
      cwd: getWorkspaceRoot(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    return {
      available: true,
      detail: trimDiffPreview([stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "gh CLI is available."),
    };
  } catch (error) {
    if (isCommandMissingError(error)) {
      return {
        available: false,
        detail: "gh CLI is not installed on this machine.",
      };
    }

    return {
      available: false,
      detail:
        (error as { message?: string })?.message ??
        "gh CLI check failed unexpectedly.",
    };
  }
}

function isGhNotLoggedInError(error: unknown) {
  const message = String(
    (error as { message?: unknown })?.message ??
      (error as { stderr?: unknown })?.stderr ??
      (error as { stdout?: unknown })?.stdout ??
      "",
  ).toLowerCase();

  return (
    message.includes("not logged into any github hosts") ||
    message.includes("not logged in") ||
    message.includes("authentication failed")
  );
}

async function checkGhAuthStatus(ghCliAvailable: boolean) {
  if (!ghCliAvailable) {
    return {
      detail: "gh CLI is unavailable, so GitHub auth cannot be checked here.",
      status: "unavailable",
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      GH_CLI_EXECUTABLE,
      ["auth", "status", "--hostname", "github.com"],
      {
        cwd: getWorkspaceRoot(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    return {
      detail: trimDiffPreview([stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "gh auth is ready."),
      status: "authenticated",
    };
  } catch (error) {
    if (isGhNotLoggedInError(error)) {
      const detail = [
        (error as { stdout?: string })?.stdout?.trim() ?? "",
        (error as { stderr?: string })?.stderr?.trim() ?? "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        detail: trimDiffPreview(detail || "gh CLI is installed, but no GitHub login is active."),
        status: "not_authenticated",
      };
    }

    return {
      detail:
        (error as { message?: string })?.message ??
        "gh auth status check failed unexpectedly.",
      status: "unknown",
    };
  }
}

function summarizeGithubEnvironment(
  isGitRepository: boolean,
  remoteEntries: string[],
  githubRemoteNames: string[],
  ghCliAvailable: boolean,
  ghAuthStatus: string,
) {
  const parts: string[] = [];

  if (!isGitRepository) {
    parts.push("This workspace is not a Git repository yet.");
  } else if (remoteEntries.length === 0) {
    parts.push("This workspace is a Git repository, but no remote is configured yet.");
  } else if (githubRemoteNames.length === 0) {
    parts.push("This workspace has remotes, but none of them point to GitHub.");
  } else {
    parts.push(`This workspace already has a GitHub remote: ${githubRemoteNames.join(", ")}.`);
  }

  parts.push(
    ghCliAvailable
      ? "gh CLI is installed."
      : "gh CLI is not installed.",
  );

  if (ghAuthStatus === "authenticated") {
    parts.push("GitHub login through gh CLI looks ready.");
  } else if (ghAuthStatus === "not_authenticated") {
    parts.push("gh CLI exists, but GitHub login is not active yet.");
  } else if (ghAuthStatus === "unavailable") {
    parts.push("GitHub login cannot be checked until gh CLI is available.");
  } else {
    parts.push("GitHub login status could not be confirmed cleanly.");
  }

  return parts.join(" ");
}

function deriveGithubReadiness(
  isGitRepository: boolean,
  remoteEntries: string[],
  githubRemoteNames: string[],
  ghCliAvailable: boolean,
  ghAuthStatus: string,
) {
  if (!isGitRepository) {
    return {
      level: "not_git_repo",
      missing: ["git repository"],
    };
  }

  if (remoteEntries.length === 0) {
    return {
      level: "git_ready_no_remote",
      missing: ["git remote"],
    };
  }

  if (githubRemoteNames.length === 0) {
    return {
      level: "remote_ready_no_github_remote",
      missing: ["github remote"],
    };
  }

  if (!ghCliAvailable) {
    return {
      level: "github_remote_ready_no_gh",
      missing: ["gh cli"],
    };
  }

  if (ghAuthStatus !== "authenticated") {
    return {
      level: "gh_available_not_logged_in",
      missing: ["github login"],
    };
  }

  return {
    level: "github_ready",
    missing: [] as string[],
  };
}

type GitChangeCounts = {
  staged: number;
  unstaged: number;
  untracked: number;
};

type ParsedChangedPath = {
  path: string;
  statusCode: string;
};

function countStatusChanges(statusEntries: string[]): GitChangeCounts {
  const counts: GitChangeCounts = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };

  for (const entry of statusEntries) {
    const statusCode = entry.slice(0, 2);

    if (statusCode === "??") {
      counts.untracked += 1;
      continue;
    }

    if (statusCode[0] && statusCode[0] !== " ") {
      counts.staged += 1;
    }

    if (statusCode[1] && statusCode[1] !== " ") {
      counts.unstaged += 1;
    }
  }

  return counts;
}

function parseChangedPaths(statusEntries: string[]) {
  const parsedPaths: ParsedChangedPath[] = [];

  for (const entry of statusEntries) {
    const statusCode = entry.slice(0, 2);
    const rawPath = entry.slice(3).trim();

    if (!rawPath) {
      continue;
    }

    const normalizedPath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").at(-1)?.trim() ?? rawPath
      : rawPath;

    parsedPaths.push({
      path: normalizedPath,
      statusCode,
    });
  }

  return parsedPaths;
}

function buildCommitScope(paths: string[]) {
  if (paths.length === 0) {
    return "workspace";
  }

  const topLevels = [...new Set(paths.map((filePath) => filePath.split(/[\\/]/)[0] || filePath))];

  if (topLevels.length === 1) {
    return topLevels[0];
  }

  return "workspace";
}

function buildCommitVerb(counts: GitChangeCounts) {
  if (counts.untracked > 0 && counts.staged === 0 && counts.unstaged === 0) {
    return "add";
  }

  return "update";
}

function suggestCommitMessage(
  branch: string | null,
  statusEntries: string[],
  diffStatLines: string[],
) {
  if (statusEntries.length === 0) {
    return "No commit message suggestion is available because there are no local changes.";
  }

  const counts = countStatusChanges(statusEntries);
  const changedPaths = parseChangedPaths(statusEntries);
  const uniquePaths = [...new Set(changedPaths.map((item) => item.path))];
  const scope = buildCommitScope(uniquePaths);
  const verb = buildCommitVerb(counts);
  const subject = `chore: ${verb} ${scope} changes`;
  const bodyLines = [
    `- branch: ${branch ?? "(unknown)"}`,
    `- changed files: ${uniquePaths.length}`,
    `- staged: ${counts.staged}, unstaged: ${counts.unstaged}, untracked: ${counts.untracked}`,
  ];

  if (uniquePaths.length > 0) {
    bodyLines.push(`- key paths: ${uniquePaths.slice(0, 5).join(", ")}`);
  }

  if (diffStatLines.length > 0) {
    bodyLines.push(`- diff stat: ${diffStatLines.slice(0, 3).join(" | ")}`);
  }

  return [subject, "", ...bodyLines].join("\n");
}

function suggestPrDraft(
  branch: string | null,
  statusEntries: string[],
  diffStatLines: string[],
) {
  if (statusEntries.length === 0) {
    return "No PR draft suggestion is available because there are no local changes.";
  }

  const commitMessageSuggestion = suggestCommitMessage(
    branch,
    statusEntries,
    diffStatLines,
  );
  const commitLines = commitMessageSuggestion.split(/\r?\n/);
  const title = commitLines[0] || "chore: update workspace changes";
  const counts = countStatusChanges(statusEntries);
  const changedPaths = parseChangedPaths(statusEntries);
  const uniquePaths = [...new Set(changedPaths.map((item) => item.path))];
  const summary = summarizeGitChanges(branch, statusEntries, diffStatLines);
  const bodyLines = [
    "## Summary",
    `- ${summary}`,
    "",
    "## What changed",
    `- Updated ${uniquePaths.length} file(s) in this branch.`,
    `- Change mix: ${counts.staged} staged, ${counts.unstaged} unstaged, ${counts.untracked} untracked.`,
  ];

  if (uniquePaths.length > 0) {
    bodyLines.push(`- Key paths: ${uniquePaths.slice(0, 5).join(", ")}`);
  }

  if (diffStatLines.length > 0) {
    bodyLines.push(`- Diff stat: ${diffStatLines.slice(0, 3).join(" | ")}`);
  }

  bodyLines.push("");
  bodyLines.push("## Testing");
  bodyLines.push("- Not run yet");

  return [title, "", ...bodyLines].join("\n");
}

function formatIssueList(
  issues: Array<{
    number?: number | null;
    state?: string | null;
    title?: string | null;
    url?: string | null;
  }>,
) {
  if (issues.length === 0) {
    return "No issues found in the current GitHub repository.";
  }

  return issues
    .map((issue) =>
      [
        `#${issue.number ?? "?"} [${(issue.state ?? "unknown").toUpperCase()}] ${issue.title ?? "(untitled)"}`,
        `url: ${issue.url ?? "(unknown)"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function formatIssueDetail(issue: {
  body?: string | null;
  number?: number | null;
  state?: string | null;
  title?: string | null;
  url?: string | null;
}) {
  return [
    `#${issue.number ?? "?"} [${(issue.state ?? "unknown").toUpperCase()}] ${issue.title ?? "(untitled)"}`,
    `url: ${issue.url ?? "(unknown)"}`,
    "body:",
    issue.body?.trim() || "(empty)",
  ].join("\n");
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizeIssueSentence(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function extractIssueTitleAndBody(issueText: string) {
  const normalizedText = issueText.replace(/\r\n/g, "\n").trim();

  if (!normalizedText) {
    return {
      body: "",
      title: "Untitled issue",
    };
  }

  const formattedIssueMatch = normalizedText.match(
    /^#\d+\s+\[[A-Z]+\]\s+([^\n]+)\n(?:url:\s+[^\n]+\n)?body:\n([\s\S]*)$/i,
  );

  if (formattedIssueMatch) {
    return {
      title: normalizeIssueSentence(formattedIssueMatch[1] ?? "") || "Untitled issue",
      body: (formattedIssueMatch[2] ?? "").trim(),
    };
  }

  const nonEmptyLines = normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length === 1) {
    return {
      title: normalizeIssueSentence(nonEmptyLines[0]) || "Untitled issue",
      body: "",
    };
  }

  const firstLine = nonEmptyLines[0]?.replace(/^#+\s*/, "") ?? "";
  const remainingBody = normalizedText
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();

  return {
    title: normalizeIssueSentence(firstLine) || "Untitled issue",
    body: remainingBody,
  };
}

function extractIssuePaths(issueText: string) {
  const matches = issueText.match(
    /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html)/g,
  );

  return dedupeStrings(
    (matches ?? [])
      .map((value) => value.trim().replace(/^`|`$/g, ""))
      .filter((value) => value.length > 0),
  ).slice(0, 6);
}

function extractIssueKeywords(title: string, body: string) {
  const combined = `${title}\n${body}`;
  const englishTokens = combined.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const chineseTokens = combined.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "when",
    "have",
    "should",
    "issue",
    "github",
    "please",
    "after",
    "before",
    "into",
  ]);

  return dedupeStrings(
    [...englishTokens, ...chineseTokens]
      .map((token) => token.trim())
      .filter((token) => {
        if (/^[A-Za-z]/.test(token)) {
          return !stopWords.has(token.toLowerCase());
        }

        return token.length >= 2;
      }),
  ).slice(0, 6);
}

function pickIssueGoal(title: string, body: string) {
  const firstBodyLine = body
    .split(/\n+/)
    .map((line) => normalizeIssueSentence(line.replace(/^[-*]\s*/, "")))
    .find((line) => line.length > 0);

  return firstBodyLine && firstBodyLine !== title ? `${title} - ${firstBodyLine}` : title;
}

function buildIssuePlan(issueText: string) {
  const { title, body } = extractIssueTitleAndBody(issueText);
  const candidatePaths = extractIssuePaths(issueText);
  const keywords = extractIssueKeywords(title, body);
  const goal = pickIssueGoal(title, body);
  const fileLines =
    candidatePaths.length > 0
      ? candidatePaths.map((filePath) => `- ${filePath}`)
      : [
          "- Issue text里没有点名具体文件。",
          `- 建议先用 search_text 搜这些关键词：${keywords.join(" / ") || "关键报错、页面名、函数名"}`,
        ];
  const firstStepLine =
    candidatePaths.length > 0
      ? `- 先读这些文件，确认问题发生点：${candidatePaths.slice(0, 3).join(", ")}`
      : `- 先用 search_text 在代码里定位关键词，再决定改哪个文件：${keywords.join(", ") || "关键报错、页面名、函数名"}`;

  return [
    `Issue goal: ${goal}`,
    "",
    "Possible related files or modules:",
    ...fileLines,
    "",
    "Recommended first step:",
    firstStepLine,
    "- 读到相关代码后，再把改动范围收窄到 1 到 3 个文件。",
    "",
    "Validation plan:",
    "- 先重现 issue 里描述的问题，记住修改前是什么表现。",
    "- 改完后重新走一遍同样步骤，确认问题消失且没有带出新问题。",
    "- 至少跑一次 npm run build，确认项目还能正常构建。",
    "",
    "Scope notes:",
    "- 第一版先做最小修复，不顺手改无关模块。",
    `- 当前规划关键词：${keywords.join(", ") || "(need manual triage)"}`,
  ].join("\n");
}

function summarizeGitChanges(
  branch: string | null,
  statusEntries: string[],
  diffStatLines: string[],
) {
  if (statusEntries.length === 0) {
    return `Branch ${branch ?? "(unknown)"} has no local changes.`;
  }

  const counts = countStatusChanges(statusEntries);
  const summaryParts = [
    `Branch ${branch ?? "(unknown)"} has ${statusEntries.length} local change${statusEntries.length === 1 ? "" : "s"}.`,
  ];

  if (counts.staged > 0) {
    summaryParts.push(`${counts.staged} staged`);
  }

  if (counts.unstaged > 0) {
    summaryParts.push(`${counts.unstaged} unstaged`);
  }

  if (counts.untracked > 0) {
    summaryParts.push(`${counts.untracked} untracked`);
  }

  if (diffStatLines.length > 0) {
    summaryParts.push(`Unstaged diff stat: ${diffStatLines.join(" | ")}`);
  } else {
    summaryParts.push("No unstaged diff stat right now.");
  }

  return summaryParts.join(" ");
}

async function runStatusAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--branch"],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const parsedStatus = parseGitStatusOutput(stdout);
    const hasChanges = parsedStatus.statusEntries.length > 0;

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "status",
          branch: parsedStatus.branch,
          isGitRepository: true,
          message: hasChanges
            ? "Git status loaded successfully."
            : "Git status loaded successfully. The working tree is clean.",
          repositoryRoot,
          status: "success",
          statusEntries: hasChanges
            ? parsedStatus.statusEntries
            : ["clean working tree"],
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "status",
            isGitRepository: false,
            message:
              "The current workspace is not a Git repository yet, so Git status is not available.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while reading Git status.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "status",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runDiffAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--"],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const diffPreview = stdout.trim();

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "diff",
          isGitRepository: true,
          message: diffPreview
            ? "Git diff loaded successfully."
            : "Git diff loaded successfully. There is no unstaged diff right now.",
          repositoryRoot,
          status: "success",
          diffPreview: diffPreview
            ? trimDiffPreview(diffPreview)
            : "no unstaged diff",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "diff",
            isGitRepository: false,
            message:
              "The current workspace is not a Git repository yet, so Git diff is not available.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while reading Git diff.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "diff",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runSummaryAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const [{ stdout: statusStdout }, { stdout: diffStatStdout }] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
      execFileAsync("git", ["diff", "--stat", "--"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    ]);

    const parsedStatus = parseGitStatusOutput(statusStdout);
    const diffStatLines = diffStatStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const summaryText = summarizeGitChanges(
      parsedStatus.branch,
      parsedStatus.statusEntries,
      diffStatLines,
    );

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "summary",
          branch: parsedStatus.branch,
          isGitRepository: true,
          message: "Git change summary loaded successfully.",
          repositoryRoot,
          status: "success",
          statusEntries:
            parsedStatus.statusEntries.length > 0
              ? parsedStatus.statusEntries
              : ["clean working tree"],
          diffPreview:
            diffStatLines.length > 0 ? diffStatLines.join("\n") : "no unstaged diff stat",
          summaryText,
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "summary",
            isGitRepository: false,
            message:
              "The current workspace is not a Git repository yet, so a Git change summary is not available.",
            repositoryRoot: null,
            status: "success",
            summaryText: "No Git summary is available because this workspace is not a Git repository yet.",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while building the Git change summary.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "summary",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runGithubEnvAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  const ghCli = await checkGhCliAvailability();
  const ghAuth = await checkGhAuthStatus(ghCli.available);

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout } = await execFileAsync("git", ["remote", "-v"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    const { parsedEntries, remoteEntries } = parseGitRemoteEntries(stdout);
    const githubRemoteNames = buildGithubRemoteNames(parsedEntries);
    const readiness = deriveGithubReadiness(
      true,
      remoteEntries,
      githubRemoteNames,
      ghCli.available,
      ghAuth.status,
    );
    const summaryText = summarizeGithubEnvironment(
      true,
      remoteEntries,
      githubRemoteNames,
      ghCli.available,
      ghAuth.status,
    );

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "github_env",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubReadinessLevel: readiness.level,
          githubReadinessMissing: readiness.missing,
          githubRemoteNames,
          isGitRepository: true,
          message: "GitHub environment check completed.",
          remoteEntries,
          repositoryRoot,
          status: "success",
          summaryText,
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      const readiness = deriveGithubReadiness(
        false,
        [],
        [],
        ghCli.available,
        ghAuth.status,
      );

      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "github_env",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            githubReadinessLevel: readiness.level,
            githubReadinessMissing: readiness.missing,
            isGitRepository: false,
            message:
              "GitHub environment check completed, but the current workspace is not a Git repository yet.",
            remoteEntries: [],
            repositoryRoot: null,
            status: "success",
            summaryText: summarizeGithubEnvironment(
              false,
              [],
              [],
              ghCli.available,
              ghAuth.status,
            ),
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while checking GitHub environment details.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "github_env",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubReadinessLevel: "check_failed",
          githubReadinessMissing: [],
          isGitRepository: false,
          message,
          remoteEntries: [],
          repositoryRoot: null,
          status: "failed",
          summaryText: ghAuth.detail,
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runCommitMessageAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const [{ stdout: statusStdout }, { stdout: diffStatStdout }] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
      execFileAsync("git", ["diff", "--stat", "--"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    ]);

    const parsedStatus = parseGitStatusOutput(statusStdout);
    const diffStatLines = diffStatStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const commitMessageSuggestion = suggestCommitMessage(
      parsedStatus.branch,
      parsedStatus.statusEntries,
      diffStatLines,
    );

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "commit_message",
          branch: parsedStatus.branch,
          commitMessageSuggestion,
          isGitRepository: true,
          message: "Commit message suggestion created successfully.",
          repositoryRoot,
          status: "success",
          statusEntries:
            parsedStatus.statusEntries.length > 0
              ? parsedStatus.statusEntries
              : ["clean working tree"],
          diffPreview:
            diffStatLines.length > 0 ? diffStatLines.join("\n") : "no unstaged diff stat",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "commit_message",
            commitMessageSuggestion:
              "No commit message suggestion is available because this workspace is not a Git repository yet.",
            isGitRepository: false,
            message:
              "Commit message suggestion is not available because the current workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while building the commit message suggestion.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "commit_message",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runPrDraftAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const [{ stdout: statusStdout }, { stdout: diffStatStdout }] = await Promise.all([
      execFileAsync("git", ["status", "--short", "--branch"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
      execFileAsync("git", ["diff", "--stat", "--"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    ]);

    const parsedStatus = parseGitStatusOutput(statusStdout);
    const diffStatLines = diffStatStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const prDraftSuggestion = suggestPrDraft(
      parsedStatus.branch,
      parsedStatus.statusEntries,
      diffStatLines,
    );

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "pr_draft",
          branch: parsedStatus.branch,
          isGitRepository: true,
          message: "PR draft suggestion created successfully.",
          prDraftSuggestion,
          repositoryRoot,
          status: "success",
          statusEntries:
            parsedStatus.statusEntries.length > 0
              ? parsedStatus.statusEntries
              : ["clean working tree"],
          diffPreview:
            diffStatLines.length > 0 ? diffStatLines.join("\n") : "no unstaged diff stat",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "pr_draft",
            isGitRepository: false,
            message:
              "PR draft suggestion is not available because the current workspace is not a Git repository yet.",
            prDraftSuggestion:
              "No PR draft suggestion is available because this workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while building the PR draft suggestion.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "pr_draft",
          isGitRepository: false,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runRepoInfoAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  const ghCli = await checkGhCliAvailability();
  const ghAuth = await checkGhAuthStatus(ghCli.available);

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout: remoteStdout } = await execFileAsync("git", ["remote", "-v"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const { parsedEntries, remoteEntries } = parseGitRemoteEntries(remoteStdout);
    const githubRemoteNames = buildGithubRemoteNames(parsedEntries);

    if (!ghCli.available) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "repo_info",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: false,
            githubRemoteNames,
            isGitRepository: true,
            message: "Repository info could not be loaded because gh CLI is not available.",
            remoteEntries,
            repoInfo: "gh CLI is not installed, so GitHub repository info cannot be read here yet.",
            repositoryRoot,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const { stdout } = await execFileAsync(
      GH_CLI_EXECUTABLE,
      ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,description"],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const parsed = JSON.parse(stdout) as {
      defaultBranchRef?: { name?: string | null } | null;
      description?: string | null;
      nameWithOwner?: string | null;
      url?: string | null;
    };

    const repoInfo = [
      `name_with_owner: ${parsed.nameWithOwner ?? "(unknown)"}`,
      `url: ${parsed.url ?? "(unknown)"}`,
      `default_branch: ${parsed.defaultBranchRef?.name || "(unknown)"}`,
      `description: ${parsed.description?.trim() || "(empty)"}`,
    ].join("\n");

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "repo_info",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubRemoteNames,
          isGitRepository: true,
          message: "GitHub repository info loaded successfully.",
          remoteEntries,
          repoInfo,
          repositoryRoot,
          status: "success",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "repo_info",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            isGitRepository: false,
            message:
              "Repository info is not available because the current workspace is not a Git repository yet.",
            repoInfo:
              "No repository info is available because this workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while reading GitHub repository info.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "repo_info",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          isGitRepository: true,
          message,
          repoInfo:
            (error as { stderr?: string })?.stderr?.trim() ||
            (error as { stdout?: string })?.stdout?.trim() ||
            null,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runIssueListAction(): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  const ghCli = await checkGhCliAvailability();
  const ghAuth = await checkGhAuthStatus(ghCli.available);

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout: remoteStdout } = await execFileAsync("git", ["remote", "-v"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const { parsedEntries, remoteEntries } = parseGitRemoteEntries(remoteStdout);
    const githubRemoteNames = buildGithubRemoteNames(parsedEntries);

    if (!ghCli.available) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_list",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: false,
            githubRemoteNames,
            isGitRepository: true,
            issueList: "gh CLI is not installed, so GitHub issues cannot be listed here yet.",
            message: "Issue list is unavailable because gh CLI is not available.",
            remoteEntries,
            repositoryRoot,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    if (ghAuth.status !== "authenticated") {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_list",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            githubRemoteNames,
            isGitRepository: true,
            issueList: "gh CLI is installed, but GitHub login is not active, so issues cannot be listed here yet.",
            message: "Issue list is unavailable because GitHub login is not active.",
            remoteEntries,
            repositoryRoot,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const { stdout } = await execFileAsync(
      GH_CLI_EXECUTABLE,
      ["issue", "list", "--limit", "10", "--json", "number,title,state,url"],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const issues = JSON.parse(stdout) as Array<{
      number?: number | null;
      state?: string | null;
      title?: string | null;
      url?: string | null;
    }>;

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_list",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubRemoteNames,
          isGitRepository: true,
          issueList: formatIssueList(issues),
          message: "GitHub issue list loaded successfully.",
          remoteEntries,
          repositoryRoot,
          status: "success",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_list",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            isGitRepository: false,
            issueList:
              "No issue list is available because this workspace is not a Git repository yet.",
            message:
              "Issue list is not available because the current workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while reading the GitHub issue list.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_list",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          isGitRepository: true,
          issueList:
            (error as { stderr?: string })?.stderr?.trim() ||
            (error as { stdout?: string })?.stdout?.trim() ||
            null,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runIssueDetailAction(input: ToolExecutionInput): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  const ghCli = await checkGhCliAvailability();
  const ghAuth = await checkGhAuthStatus(ghCli.available);
  const issueNumber =
    typeof input === "string" ? null : typeof input.issue_number === "number"
      ? input.issue_number
      : null;

  try {
    const repositoryRoot = await getRepositoryRoot(workspaceRoot);
    const { stdout: remoteStdout } = await execFileAsync("git", ["remote", "-v"], {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const { parsedEntries, remoteEntries } = parseGitRemoteEntries(remoteStdout);
    const githubRemoteNames = buildGithubRemoteNames(parsedEntries);

    if (issueNumber === null || issueNumber <= 0) {
      return {
        ok: false,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_detail",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            githubRemoteNames,
            isGitRepository: true,
            issueDetail:
              "Missing issue number. Please provide a specific issue number such as issue 3.",
            message: "Issue detail is unavailable because no valid issue number was provided.",
            remoteEntries,
            repositoryRoot,
            status: "rejected",
            workspaceRoot,
          }),
        ),
      };
    }

    if (!ghCli.available) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_detail",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: false,
            githubRemoteNames,
            isGitRepository: true,
            issueDetail: "gh CLI is not installed, so GitHub issue detail cannot be read here yet.",
            message: "Issue detail is unavailable because gh CLI is not available.",
            remoteEntries,
            repositoryRoot,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    if (ghAuth.status !== "authenticated") {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_detail",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            githubRemoteNames,
            isGitRepository: true,
            issueDetail:
              "gh CLI is installed, but GitHub login is not active, so issue detail cannot be read here yet.",
            message: "Issue detail is unavailable because GitHub login is not active.",
            remoteEntries,
            repositoryRoot,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const { stdout } = await execFileAsync(
      GH_CLI_EXECUTABLE,
      [
        "issue",
        "view",
        String(issueNumber),
        "--json",
        "number,title,state,url,body",
      ],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    const issue = JSON.parse(stdout) as {
      body?: string | null;
      number?: number | null;
      state?: string | null;
      title?: string | null;
      url?: string | null;
    };

    return {
      ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_detail",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubRemoteNames,
          isGitRepository: true,
          issueDetail: formatIssueDetail(issue),
          message: `GitHub issue #${issueNumber} loaded successfully.`,
          remoteEntries,
          repositoryRoot,
          status: "success",
          workspaceRoot,
        }),
      ),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        ok: true,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_detail",
            ghAuthStatus: ghAuth.status,
            ghCliAvailable: ghCli.available,
            isGitRepository: false,
            issueDetail:
              "No issue detail is available because this workspace is not a Git repository yet.",
            message:
              "Issue detail is not available because the current workspace is not a Git repository yet.",
            repositoryRoot: null,
            status: "success",
            workspaceRoot,
          }),
        ),
      };
    }

    const message =
      (error as { message?: string })?.message ??
      "git_inspect failed while reading the GitHub issue detail.";

    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_detail",
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          isGitRepository: true,
          issueDetail:
            (error as { stderr?: string })?.stderr?.trim() ||
            (error as { stdout?: string })?.stdout?.trim() ||
            null,
          message,
          repositoryRoot: null,
          status: "failed",
          workspaceRoot,
        }),
      ),
    };
  }
}

async function runIssuePlanAction(input: ToolExecutionInput): Promise<ToolResult> {
  const workspaceRoot = getWorkspaceRoot();
  const ghCli = await checkGhCliAvailability();
  const ghAuth = await checkGhAuthStatus(ghCli.available);
  const issueTextFromInput =
    typeof input === "string" ? "" : typeof input.issue_text === "string" ? input.issue_text : "";
  const issueNumber =
    typeof input === "string" ? null : typeof input.issue_number === "number"
      ? input.issue_number
      : null;

  let issueText = issueTextFromInput.trim();

  if (!issueText && (issueNumber === null || issueNumber <= 0)) {
    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_plan",
          isGitRepository: false,
          issuePlan:
            'Missing issue content. Please pass {"action":"issue_plan","issue_text":"..."} or {"action":"issue_plan","issue_number":3}.',
          message:
            "Issue planning is unavailable because neither issue_text nor a valid issue_number was provided.",
          repositoryRoot: null,
          status: "rejected",
          workspaceRoot,
        }),
      ),
    };
  }

  let repositoryRoot: string | null = null;
  let isGitRepository = false;
  let githubRemoteNames: string[] = [];
  let remoteEntries: string[] = [];

  try {
    repositoryRoot = await getRepositoryRoot(workspaceRoot);
    isGitRepository = true;

    if (!issueText && issueNumber !== null && issueNumber > 0) {
      const { stdout: remoteStdout } = await execFileAsync("git", ["remote", "-v"], {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const parsedRemotes = parseGitRemoteEntries(remoteStdout);
      remoteEntries = parsedRemotes.remoteEntries;
      githubRemoteNames = buildGithubRemoteNames(parsedRemotes.parsedEntries);

      if (!ghCli.available) {
        return {
          ok: true,
          content: formatGitInspectReport(
            createGitInspectReport({
              action: "issue_plan",
              ghAuthStatus: ghAuth.status,
              ghCliAvailable: false,
              githubRemoteNames,
              isGitRepository: true,
              issuePlan:
                "gh CLI is not installed, so issue number planning is not available yet. You can still paste the issue text directly into issue_text.",
              message: "Issue planning from issue number is unavailable because gh CLI is not available.",
              remoteEntries,
              repositoryRoot,
              status: "success",
              workspaceRoot,
            }),
          ),
        };
      }

      if (ghAuth.status !== "authenticated") {
        return {
          ok: true,
          content: formatGitInspectReport(
            createGitInspectReport({
              action: "issue_plan",
              ghAuthStatus: ghAuth.status,
              ghCliAvailable: ghCli.available,
              githubRemoteNames,
              isGitRepository: true,
              issuePlan:
                "GitHub login is not active, so issue number planning is not available yet. You can still paste the issue text directly into issue_text.",
              message:
                "Issue planning from issue number is unavailable because GitHub login is not active.",
              remoteEntries,
              repositoryRoot,
              status: "success",
              workspaceRoot,
            }),
          ),
        };
      }

      const { stdout } = await execFileAsync(
        GH_CLI_EXECUTABLE,
        [
          "issue",
          "view",
          String(issueNumber),
          "--json",
          "number,title,state,url,body",
        ],
        {
          cwd: workspaceRoot,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );

      const issue = JSON.parse(stdout) as {
        body?: string | null;
        number?: number | null;
        state?: string | null;
        title?: string | null;
        url?: string | null;
      };

      issueText = formatIssueDetail(issue);
    }
  } catch (error) {
    if (!isNotGitRepositoryError(error)) {
      const message =
        (error as { message?: string })?.message ??
        "git_inspect failed while checking repository state for issue planning.";

      return {
        ok: false,
        content: formatGitInspectReport(
          createGitInspectReport({
            action: "issue_plan",
            isGitRepository: false,
            message,
            repositoryRoot: null,
            status: "failed",
            workspaceRoot,
          }),
        ),
      };
    }
  }

  return {
    ok: true,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "issue_plan",
          isGitRepository,
          ghAuthStatus: ghAuth.status,
          ghCliAvailable: ghCli.available,
          githubRemoteNames,
          issuePlan: buildIssuePlan(issueText),
          message:
            issueNumber !== null && issueNumber > 0
              ? `Issue planning draft created successfully from GitHub issue #${issueNumber}.`
              : "Issue planning draft created successfully from pasted issue text.",
          remoteEntries,
          repositoryRoot,
          status: "success",
          workspaceRoot,
      }),
    ),
  };
}

async function executeGitInspect(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseGitInspectInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: formatGitInspectReport(
        createGitInspectReport({
          action: "check_repo",
          isGitRepository: false,
          message: parsed.message,
          repositoryRoot: null,
          status: "rejected",
          workspaceRoot: getWorkspaceRoot(),
        }),
      ),
    };
  }

  if (parsed.action === "check_repo") {
    return runCheckRepoAction();
  }

  if (parsed.action === "status") {
    return runStatusAction();
  }

  if (parsed.action === "diff") {
    return runDiffAction();
  }

  if (parsed.action === "summary") {
    return runSummaryAction();
  }

  if (parsed.action === "github_env") {
    return runGithubEnvAction();
  }

  if (parsed.action === "commit_message") {
    return runCommitMessageAction();
  }

  if (parsed.action === "pr_draft") {
    return runPrDraftAction();
  }

  if (parsed.action === "repo_info") {
    return runRepoInfoAction();
  }

  if (parsed.action === "issue_list") {
    return runIssueListAction();
  }

  if (parsed.action === "issue_detail") {
    return runIssueDetailAction(input);
  }

  return runIssuePlanAction(input);
}

export const gitInspectTool: AgentTool = {
  name: "git_inspect",
  description:
    "Check Git and GitHub environment facts for the current workspace. MVP actions: detect whether the workspace is inside a Git repository, read git status, read a minimal git diff preview, produce a short local change summary, inspect GitHub readiness such as remotes and gh CLI availability, suggest a commit message draft, suggest a PR draft description, read basic GitHub repository info, list repository issues, read one issue detail, and turn either pasted issue text or one GitHub issue number into a minimal execution plan.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          'Required Git inspection action. Current MVP supports "check_repo", "status", "diff", "summary", "github_env", "commit_message", "pr_draft", "repo_info", "issue_list", "issue_detail", or "issue_plan".',
      },
      issue_number: {
        type: "number",
        description:
          'Required when action is "issue_detail". Optional when action is "issue_plan". The GitHub issue number to inspect or plan from, such as 3.',
      },
      issue_text: {
        type: "string",
        description:
          'Optional when action is "issue_plan". Paste the issue text here so the tool can draft a minimal code-change plan without reading GitHub first.',
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  execute: executeGitInspect,
};
