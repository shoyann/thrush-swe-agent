import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { getWorkspaceRoot } from "@/lib/tools/workspace-path";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MAX_TIMEOUT_SECONDS = 60 * 60;
const MAX_OUTPUT_LENGTH = 12_000;

type SweAgentAction = "check" | "plan" | "run";

type ParsedSweAgentInput =
  | {
      ok: true;
      action: SweAgentAction;
      costLimit: number | null;
      githubIssueUrl: string;
      githubRepoUrl: string;
      modelName: string;
      problemStatement: null;
      timeoutSeconds: number;
    }
  | {
      ok: true;
      action: SweAgentAction;
      costLimit: number | null;
      githubIssueUrl: null;
      githubRepoUrl: null;
      modelName: string;
      problemStatement: string;
      timeoutSeconds: number;
    }
  | {
      ok: true;
      action: "check";
      costLimit: number | null;
      githubIssueUrl: null;
      githubRepoUrl: null;
      modelName: string;
      problemStatement: null;
      timeoutSeconds: number;
    }
  | {
      ok: false;
      message: string;
    };

type SweAgentCommandPlan = {
  args: string[];
  command: string;
  displayCommand: string;
  outputDir: string;
};

function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function getStringArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function getNumberArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeAction(rawAction: string): SweAgentAction | null {
  const action = rawAction.trim().toLowerCase();

  if (action === "" || action === "plan") {
    return "plan";
  }

  if (action === "check" || action === "run") {
    return action;
  }

  return null;
}

function normalizeTimeoutSeconds(timeoutSeconds: number | null) {
  if (timeoutSeconds === null) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return Math.min(
    Math.max(Math.floor(timeoutSeconds), 10),
    MAX_TIMEOUT_SECONDS,
  );
}

function getConfiguredSweAgentModelName(inputModelName: string) {
  return (
    inputModelName ||
    process.env.SWE_AGENT_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    ""
  );
}

function deriveGithubRepoUrl(issueUrl: string) {
  const match = issueUrl.match(
    /^https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/\d+\/?$/i,
  );

  if (!match) {
    return null;
  }

  return `https://github.com/${match[1]}/${match[2]}`;
}

function normalizeGithubIssueUrl(issueUrl: string) {
  const repoUrl = deriveGithubRepoUrl(issueUrl);

  if (!repoUrl) {
    return null;
  }

  return {
    issueUrl: issueUrl.replace(/\/$/, ""),
    repoUrl,
  };
}

function parseSweAgentObjectInput(input: ToolCallArgs): ParsedSweAgentInput {
  const action = normalizeAction(getStringArg(input, "action"));
  const modelName = getConfiguredSweAgentModelName(getStringArg(input, "model_name"));
  const timeoutSeconds = normalizeTimeoutSeconds(getNumberArg(input, "timeout_seconds"));
  const costLimit = getNumberArg(input, "cost_limit");
  const problemStatement = getStringArg(input, "problem_statement");
  const rawGithubIssueUrl = getStringArg(input, "github_issue_url");
  const rawGithubRepoUrl = getStringArg(input, "github_repo_url");

  if (!action) {
    return {
      ok: false,
      message: 'swe_agent action must be "check", "plan", or "run".',
    };
  }

  if (action === "check") {
    return {
      ok: true,
      action,
      costLimit,
      githubIssueUrl: null,
      githubRepoUrl: null,
      modelName,
      problemStatement: null,
      timeoutSeconds,
    };
  }

  if (problemStatement && rawGithubIssueUrl) {
    return {
      ok: false,
      message:
        "swe_agent needs either problem_statement for the current local workspace or github_issue_url for a GitHub issue, not both.",
    };
  }

  if (rawGithubIssueUrl) {
    const normalizedIssue = normalizeGithubIssueUrl(rawGithubIssueUrl);

    if (!normalizedIssue) {
      return {
        ok: false,
        message:
          'github_issue_url must look like "https://github.com/owner/repo/issues/123".',
      };
    }

    const repoUrl = rawGithubRepoUrl || normalizedIssue.repoUrl;

    if (!repoUrl.startsWith("https://github.com/")) {
      return {
        ok: false,
        message: "github_repo_url must start with https://github.com/.",
      };
    }

    return {
      ok: true,
      action,
      costLimit,
      githubIssueUrl: normalizedIssue.issueUrl,
      githubRepoUrl: repoUrl.replace(/\/$/, ""),
      modelName,
      problemStatement: null,
      timeoutSeconds,
    };
  }

  if (!problemStatement) {
    return {
      ok: false,
      message:
        "swe_agent needs a problem_statement for the current local workspace, or a github_issue_url for a GitHub issue.",
    };
  }

  return {
    ok: true,
    action,
    costLimit,
    githubIssueUrl: null,
    githubRepoUrl: null,
    modelName,
    problemStatement,
    timeoutSeconds,
  };
}

function parseSweAgentStringInput(input: string): ParsedSweAgentInput {
  return parseSweAgentObjectInput({
    action: parseTagBlock(input, "action") ?? "plan",
    cost_limit: null,
    github_issue_url: parseTagBlock(input, "github_issue_url") ?? "",
    github_repo_url: parseTagBlock(input, "github_repo_url") ?? "",
    model_name: parseTagBlock(input, "model_name") ?? "",
    problem_statement: parseTagBlock(input, "problem_statement") ?? input.trim(),
    timeout_seconds: null,
  });
}

function parseSweAgentInput(input: ToolExecutionInput): ParsedSweAgentInput {
  if (typeof input === "string") {
    return parseSweAgentStringInput(input);
  }

  return parseSweAgentObjectInput(input);
}

function getSweAgentBinary() {
  return process.env.SWE_AGENT_BIN?.trim() || "sweagent";
}

function getSweAgentOutputDir() {
  return path.resolve(process.cwd(), "data", "swe-agent-runs");
}

function getProblemStatementDir() {
  return path.resolve(process.cwd(), "data", "swe-agent-problems");
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function formatDisplayCommand(command: string, args: string[]) {
  return [command, ...args].map(shellQuote).join(" ");
}

function writeProblemStatementFile(problemStatement: string) {
  const problemDir = getProblemStatementDir();
  mkdirSync(problemDir, { recursive: true });

  const hash = createHash("sha256")
    .update(problemStatement)
    .update(String(Date.now()))
    .digest("hex")
    .slice(0, 12);
  const problemPath = path.join(problemDir, `problem-${hash}.md`);

  writeFileSync(problemPath, `${problemStatement.trim()}\n`, "utf8");
  return problemPath;
}

function buildSweAgentCommand(input: Extract<ParsedSweAgentInput, { ok: true }>, options: {
  problemStatementPath?: string;
} = {}): SweAgentCommandPlan {
  const command = getSweAgentBinary();
  const outputDir = getSweAgentOutputDir();
  const modelName = input.modelName || "<model-name>";
  const args = [
    "run",
    `--agent.model.name=${modelName}`,
    `--output_dir=${outputDir}`,
  ];

  if (input.costLimit !== null && input.costLimit > 0) {
    args.push(`--agent.model.per_instance_cost_limit=${input.costLimit}`);
  }

  if (input.githubIssueUrl && input.githubRepoUrl) {
    args.push(
      `--env.repo.github_url=${input.githubRepoUrl}`,
      `--problem_statement.github_url=${input.githubIssueUrl}`,
    );
  } else if (input.problemStatement) {
    args.push(
      `--env.repo.path=${getWorkspaceRoot()}`,
      `--problem_statement.path=${options.problemStatementPath ?? "<generated-problem-statement.md>"}`,
    );
  }

  return {
    args,
    command,
    displayCommand: formatDisplayCommand(command, args),
    outputDir,
  };
}

function trimOutput(text: string) {
  if (text.length <= MAX_OUTPUT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
}

function formatPlanResult(plan: SweAgentCommandPlan, input: Extract<ParsedSweAgentInput, { ok: true }>) {
  const lines = [
    "tool: swe_agent",
    "status: plan",
    "What this does:",
    "Runs the official SWE-agent CLI as an external specialist for one GitHub issue or one local workspace task.",
    "It is not vendored into Thrush; it must be installed separately on the machine running Thrush.",
    "",
    "Command preview:",
    plan.displayCommand,
    "",
    `Output directory: ${plan.outputDir}`,
  ];

  if (!input.modelName) {
    lines.push(
      "",
      "Missing model_name for a real run. Pass model_name, or set SWE_AGENT_MODEL in .env.local.",
    );
  }

  lines.push(
    "",
    "To actually run it from Thrush, set SWE_AGENT_TOOL_ENABLED=true and make sure the sweagent command is installed on PATH, or set SWE_AGENT_BIN to its absolute path.",
  );

  return lines.join("\n");
}

function isSweAgentToolEnabled() {
  return process.env.SWE_AGENT_TOOL_ENABLED?.trim().toLowerCase() === "true";
}

async function checkSweAgentInstall(): Promise<ToolResult> {
  const command = getSweAgentBinary();

  try {
    const { stdout, stderr } = await execFileAsync(command, ["--help"], {
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });

    return {
      ok: true,
      content: [
        "tool: swe_agent",
        "status: installed",
        `command: ${command}`,
        "stdout:",
        trimOutput(String(stdout ?? "").trim()),
        "stderr:",
        trimOutput(String(stderr ?? "").trim()),
      ].join("\n"),
    };
  } catch (error) {
    const result = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };

    return {
      ok: false,
      content: [
        "tool: swe_agent",
        "status: missing_or_failed",
        `command: ${command}`,
        "message:",
        result.message || "Could not run sweagent --help.",
        "stdout:",
        trimOutput((result.stdout ?? "").trim()) || "(empty)",
        "stderr:",
        trimOutput((result.stderr ?? "").trim()) || "(empty)",
      ].join("\n"),
    };
  }
}

async function executeSweAgent(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseSweAgentInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  if (parsed.action === "check") {
    return checkSweAgentInstall();
  }

  const dryRunPlan = buildSweAgentCommand(parsed);

  if (parsed.action === "plan") {
    return {
      ok: true,
      content: formatPlanResult(dryRunPlan, parsed),
    };
  }

  if (!parsed.modelName) {
    return {
      ok: false,
      content: [
        "swe_agent cannot run yet because no model name is configured.",
        "Pass model_name in the tool input, or set SWE_AGENT_MODEL in .env.local.",
        "",
        formatPlanResult(dryRunPlan, parsed),
      ].join("\n"),
    };
  }

  if (!isSweAgentToolEnabled()) {
    return {
      ok: false,
      content: [
        "swe_agent run is disabled by default because it can start containers, execute code, use network access, and spend model tokens.",
        "Set SWE_AGENT_TOOL_ENABLED=true in .env.local to allow real runs.",
        "",
        formatPlanResult(dryRunPlan, parsed),
      ].join("\n"),
    };
  }

  mkdirSync(dryRunPlan.outputDir, { recursive: true });
  const problemStatementPath = parsed.problemStatement
    ? writeProblemStatementFile(parsed.problemStatement)
    : undefined;
  const runPlan = buildSweAgentCommand(parsed, { problemStatementPath });

  try {
    const { stdout, stderr } = await execFileAsync(runPlan.command, runPlan.args, {
      cwd: getWorkspaceRoot(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: parsed.timeoutSeconds * 1000,
      windowsHide: true,
    });

    return {
      ok: true,
      content: [
        "tool: swe_agent",
        "status: success",
        `command: ${runPlan.displayCommand}`,
        `output_dir: ${runPlan.outputDir}`,
        problemStatementPath ? `problem_statement_path: ${problemStatementPath}` : null,
        "stdout:",
        trimOutput(String(stdout ?? "").trim()) || "(empty)",
        "stderr:",
        trimOutput(String(stderr ?? "").trim()) || "(empty)",
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    };
  } catch (error) {
    const result = error as {
      code?: number | string;
      message?: string;
      stderr?: string;
      stdout?: string;
    };

    return {
      ok: false,
      content: [
        "tool: swe_agent",
        "status: failed",
        `command: ${runPlan.displayCommand}`,
        `exit_code: ${result.code ?? "unknown"}`,
        `output_dir: ${runPlan.outputDir}`,
        problemStatementPath ? `problem_statement_path: ${problemStatementPath}` : null,
        "message:",
        result.message || "sweagent failed while running.",
        "stdout:",
        trimOutput((result.stdout ?? "").trim()) || "(empty)",
        "stderr:",
        trimOutput((result.stderr ?? "").trim()) || "(empty)",
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    };
  }
}

export const sweAgentTool: AgentTool = {
  name: "swe_agent",
  description:
    "Plan, check, or run the official external SWE-agent CLI for one GitHub issue or one local workspace task. Real runs require SWE_AGENT_TOOL_ENABLED=true and an installed sweagent command.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          'Required action: "check" verifies the sweagent CLI, "plan" previews the command, "run" executes it only when SWE_AGENT_TOOL_ENABLED=true.',
      },
      problem_statement: {
        type: "string",
        description:
          "Optional local task for the current workspace. Use this instead of github_issue_url.",
      },
      github_issue_url: {
        type: "string",
        description:
          "Optional GitHub issue URL such as https://github.com/owner/repo/issues/123. Use this instead of problem_statement.",
      },
      github_repo_url: {
        type: "string",
        description:
          "Optional GitHub repository URL. If omitted, it is derived from github_issue_url.",
      },
      model_name: {
        type: "string",
        description:
          "Optional SWE-agent model name, such as gpt-4o or claude-sonnet-4-20250514. Required for real runs unless SWE_AGENT_MODEL is set.",
      },
      cost_limit: {
        type: "number",
        description: "Optional SWE-agent per-instance cost limit.",
      },
      timeout_seconds: {
        type: "number",
        description:
          "Optional run timeout in seconds. Defaults to 1800 and is capped at 3600.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  execute: executeSweAgent,
};

export const __sweAgentTestInternals = {
  buildSweAgentCommand,
  deriveGithubRepoUrl,
  normalizeGithubIssueUrl,
  parseSweAgentInput,
};
