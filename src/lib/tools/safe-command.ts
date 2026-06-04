import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "./types";
import { getWorkspaceRoot, resolveWorkspacePath } from "./workspace-path";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_LENGTH = 8_000;
const BLOCKED_COMMANDS = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "curl",
  "del",
  "move",
  "node",
  "node.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "python",
  "python.exe",
  "rm",
  "sh",
  "wget",
]);

type SafeExecutable = "git" | "npm" | "rg";

type SafeCommandPlan =
  | {
      ok: true;
      commandText: string;
      executable: SafeExecutable;
      executableArgs: string[];
    }
  | {
      ok: false;
      message: string;
    };

const ALLOWED_COMMANDS = new Set<SafeExecutable>(["git", "npm", "rg"]);

type SafeCommandStatus = "success" | "failed" | "rejected";

type SafeCommandReport = {
  commandText: string;
  exitCode: number | string | null;
  message: string;
  status: SafeCommandStatus;
  stderr: string;
  stdout: string;
};

function resolveRuntimeCommand(
  executable: SafeExecutable,
  executableArgs: string[],
) {
  if (process.platform === "win32" && executable === "npm") {
    return {
      executable: "cmd.exe",
      executableArgs: ["/d", "/c", "npm.cmd", ...executableArgs],
    };
  }

  return {
    executable,
    executableArgs,
  };
}

function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseArgTags(text: string) {
  return [...text.matchAll(/<arg>([\s\S]*?)<\/arg>/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0);
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

function normalizeRelativePath(targetPath: string) {
  return path.relative(getWorkspaceRoot(), targetPath).replace(/\\/g, "/") || ".";
}

function trimOutput(text: string) {
  if (text.length <= MAX_OUTPUT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
}

function formatSafeCommandReport(report: SafeCommandReport) {
  return [
    "tool: safe_command",
    `status: ${report.status}`,
    `command: ${report.commandText}`,
    `exit_code: ${report.exitCode ?? "unknown"}`,
    "message:",
    report.message || "(empty)",
    "stdout:",
    report.stdout || "(empty)",
    "stderr:",
    report.stderr || "(empty)",
  ].join("\n");
}

function isAllowedCommand(command: string): command is SafeExecutable {
  return ALLOWED_COMMANDS.has(command as SafeExecutable);
}

function parseSafeCommandObjectInput(input: ToolCallArgs) {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  const rawArgs = Array.isArray(input.args) ? input.args : [];
  const args = rawArgs.filter((value): value is string => typeof value === "string");

  if (!command) {
    return {
      ok: false,
      message: 'safe_command input must include a non-empty "command" value.',
    } as const;
  }

  return {
    ok: true,
    command: command.toLowerCase(),
    args,
  } as const;
}

function parseSafeCommandStringInput(input: string) {
  const command = parseTagBlock(input, "command");
  const args = parseArgTags(input);

  if (!command) {
    return {
      ok: false,
      message:
        "safe_command input must include <command>rg</command> and one or more <arg>...</arg> blocks.",
    } as const;
  }

  return {
    ok: true,
    command: command.trim().toLowerCase(),
    args,
  } as const;
}

function buildAllowedRgCall(args: string[]): SafeCommandPlan {
  if (args.length === 0) {
    return {
      ok: false,
      message:
        'safe_command currently allows only rg search or rg --files. Example: <command>rg</command><arg>TODO</arg><arg>src</arg>.',
    } as const;
  }

  if (args[0] === "--files") {
    if (args.length > 2) {
      return {
        ok: false,
        message: "rg --files allows at most one optional path argument.",
      } as const;
    }

    if (args[1]?.startsWith("-")) {
      return {
        ok: false,
        message:
          "safe_command does not allow rg --files to receive extra flags through the optional path slot.",
      } as const;
    }

    const targetPath = resolveWorkspacePath(args[1] ?? ".");
    const relativePath = normalizeRelativePath(targetPath);

    return {
      ok: true,
      commandText: `rg --files ${relativePath}`.trim(),
      executable: "rg",
      executableArgs: ["--files", relativePath],
    } as const;
  }

  if (args[0].startsWith("-")) {
    return {
      ok: false,
      message:
        "safe_command does not allow custom rg flags yet. Use plain search text, or rg --files.",
    } as const;
  }

  if (args.length > 2) {
    return {
      ok: false,
      message:
        "safe_command rg search allows only a search pattern plus one optional workspace path.",
    } as const;
  }

  const query = args[0];
  const targetPath = resolveWorkspacePath(args[1] ?? ".");
  const relativePath = normalizeRelativePath(targetPath);

  return {
    ok: true,
    commandText: `rg ${JSON.stringify(query)} ${relativePath}`.trim(),
    executable: "rg",
    executableArgs: [
      "--color",
      "never",
      "--smart-case",
      "--line-number",
      "--no-heading",
      "--no-messages",
      "--",
      query,
      relativePath,
    ],
  } as const;
}

function buildAllowedGitCall(args: string[]): SafeCommandPlan {
  if (args.length !== 1 || args[0] !== "status") {
    return {
      ok: false,
      message:
        'safe_command currently allows only git status. Example: {"command":"git","args":["status"]}.',
    };
  }

  return {
    ok: true,
    commandText: "git status",
    executable: "git",
    executableArgs: ["status", "--short", "--branch"],
  };
}

function workspaceHasNpmScript(scriptName: string) {
  const packageJsonPath = path.join(getWorkspaceRoot(), "package.json");

  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };

    return typeof packageJson.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

function buildAllowedNpmCall(args: string[]): SafeCommandPlan {
  if (args.length === 2 && args[0] === "run" && args[1] === "build") {
    return {
      ok: true,
      commandText: "npm run build",
      executable: "npm",
      executableArgs: ["run", "build"],
    };
  }

  if (args.length === 2 && args[0] === "run" && args[1] === "lint") {
    if (!workspaceHasNpmScript("lint")) {
      return {
        ok: false,
        message:
          'safe_command checked package.json and did not find a "lint" script, so npm run lint is not allowed in this workspace.',
      };
    }

    return {
      ok: true,
      commandText: "npm run lint",
      executable: "npm",
      executableArgs: ["run", "lint"],
    };
  }

  if (args.length === 1 && args[0] === "test") {
    if (!workspaceHasNpmScript("test")) {
      return {
        ok: false,
        message:
          'safe_command checked package.json and did not find a "test" script, so npm test is not allowed in this workspace.',
      };
    }

    return {
      ok: true,
      commandText: "npm test",
      executable: "npm",
      executableArgs: ["test"],
    };
  }

  return {
    ok: false,
    message:
      'safe_command currently allows only npm run build, npm run lint when package.json includes a lint script, or npm test when package.json includes a test script.',
  };
}

function buildAllowedCommandCall(
  command: SafeExecutable,
  args: string[],
): SafeCommandPlan {
  if (command === "rg") {
    return buildAllowedRgCall(args);
  }

  if (command === "git") {
    return buildAllowedGitCall(args);
  }

  return buildAllowedNpmCall(args);
}

function parseSafeCommandInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return parseSafeCommandStringInput(input);
  }

  return parseSafeCommandObjectInput(input);
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

async function executeSafeCommand(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseSafeCommandInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: formatSafeCommandReport({
        commandText: "(invalid input)",
        exitCode: null,
        message: parsed.message,
        status: "rejected",
        stderr: "",
        stdout: "",
      }),
    };
  }

  if (BLOCKED_COMMANDS.has(parsed.command)) {
    return {
      ok: false,
      content: formatSafeCommandReport({
        commandText: parsed.command,
        exitCode: null,
        message: `The command "${parsed.command}" is blocked for safety.`,
        status: "rejected",
        stderr: "",
        stdout: "",
      }),
    };
  }

  if (!isAllowedCommand(parsed.command)) {
    return {
      ok: false,
      content: formatSafeCommandReport({
        commandText: parsed.command,
        exitCode: null,
        message: `The command "${parsed.command}" is not in the safe_command allowlist.`,
        status: "rejected",
        stderr: "",
        stdout: "",
      }),
    };
  }

  const allowedCall = buildAllowedCommandCall(parsed.command, parsed.args);
  if (!allowedCall.ok) {
    return {
      ok: false,
      content: formatSafeCommandReport({
        commandText: parsed.command,
        exitCode: null,
        message: allowedCall.message,
        status: "rejected",
        stderr: "",
        stdout: "",
      }),
    };
  }

  const runtimeCommand = resolveRuntimeCommand(
    allowedCall.executable,
    allowedCall.executableArgs,
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      runtimeCommand.executable,
      runtimeCommand.executableArgs,
      {
        cwd: getWorkspaceRoot(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    return {
      ok: true,
      content: formatSafeCommandReport({
        commandText: allowedCall.commandText,
        exitCode: 0,
        message: "Command allowed and executed successfully.",
        status: "success",
        stderr: trimOutput(stderr.trim()),
        stdout: trimOutput(stdout.trim()),
      }),
    };
  } catch (error) {
    const result = error as {
      code?: number | string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };

    if (allowedCall.executable === "rg" && result.code === 1) {
      return {
        ok: true,
        content: formatSafeCommandReport({
          commandText: allowedCall.commandText,
          exitCode: 1,
          message: "Command ran successfully, but no matches were found.",
          status: "success",
          stderr: trimOutput((result.stderr ?? "").trim()),
          stdout: trimOutput((result.stdout ?? "").trim()),
        }),
      };
    }

    const stdout = trimOutput((result.stdout ?? "").trim());
    const stderr = trimOutput((result.stderr ?? "").trim());

    return {
      ok: false,
      content: formatSafeCommandReport({
        commandText: allowedCall.commandText,
        exitCode: result.code ?? null,
        message: result.message || "safe_command failed while running the allowed command.",
        status: "failed",
        stderr: stderr || result.message || "",
        stdout,
      }),
    };
  }
}

export const safeCommandTool: AgentTool = {
  name: "safe_command",
  description:
    "Run one whitelisted local command inside the current workspace. MVP allowlist: rg search, rg --files, git status, npm run build, npm run lint only when package.json includes a lint script, and npm test only when package.json includes a test script.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          'Required allowed command name. Current MVP allowlist: "rg", "git", or "npm".',
      },
      args: {
        type: "array",
        description: "Required command arguments in order.",
        items: {
          type: "string",
        },
      },
    },
    required: ["command", "args"],
    additionalProperties: false,
  },
  execute: executeSafeCommand,
  onResult(_goal, result, toolRuns) {
    const toolRun = toolRuns.at(-1);

    if (!toolRun || !isVerificationSafeCommandInput(toolRun.input)) {
      return null;
    }

    return {
      type: "immediate",
      message: result.content,
    };
  },
};

export const __safeCommandTestInternals = {
  buildAllowedCommandCall,
};
