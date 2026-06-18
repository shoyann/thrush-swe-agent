import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AutoReadiness,
  AutoReadinessCheck,
} from "@/types/auto";
import { resolveMiniCommand } from "@/lib/auto/mini-resolver";
import { getMiniRuntimeStatus } from "./mini-runtime";
import {
  type CommandRunner,
  dockerCheck,
  gitCheck,
  modelCheck,
} from "@/lib/auto/readiness-checks";
import { createRecommendedMiniPresetSnapshot } from "@/lib/auto/recommended-environment";
import { getMiniPreset } from "@/lib/db/auto-store";
import { getProject } from "@/lib/db/store";

const execFileAsync = promisify(execFile);

const defaultRunner: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    maxBuffer: 2 * 1024 * 1024,
    timeout: options?.timeout ?? 10_000,
    windowsHide: true,
  });

  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

function runtimeCheck(): AutoReadinessCheck {
  if (process.env.AUTO_RUN_MINI_COMMAND?.trim()) {
    return {
      message:
        "Auto runtime is using a custom mini-swe-agent command from AUTO_RUN_MINI_COMMAND.",
      name: "runtime",
      ok: true,
      required: false,
    };
  }

  const runtime = getMiniRuntimeStatus();

  return {
    category: runtime.ready ? undefined : "mini_unavailable",
    message: runtime.message,
    name: "runtime",
    ok: runtime.ready,
    required: true,
  };
}

async function miniCheck(runCommand: CommandRunner): Promise<AutoReadinessCheck> {
  try {
    const mini = resolveMiniCommand();
    const probeArgs =
      mini.command.endsWith("python") || mini.command.endsWith("python.exe")
        ? ["--version"]
        : ["--version"];

    await runCommand(mini.command, probeArgs, { timeout: 15_000 });

    return {
      message: `mini-swe-agent runner is available through ${mini.source}.`,
      name: "mini",
      ok: true,
      required: true,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Unknown error.";

    return {
      category: "mini_unavailable",
      message: `mini-swe-agent command is not ready. Run npm run bootstrap:mini or configure AUTO_RUN_MINI_COMMAND. Details: ${message}`,
      name: "mini",
      ok: false,
      required: true,
    };
  }
}

async function githubCheck(
  workspacePath: string,
  runCommand: CommandRunner,
): Promise<AutoReadinessCheck> {
  try {
    await runCommand("git", ["remote", "get-url", "origin"], {
      cwd: workspacePath,
    });
    await runCommand("gh", ["auth", "status"], { timeout: 10_000 });

    return {
      message: "GitHub Draft PR creation is ready.",
      name: "github",
      ok: true,
      required: false,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Unknown error.";

    return {
      category: "github_unavailable",
      message: `Draft PR is not ready yet. You can still run Auto, but PR creation will require GitHub CLI login and an origin remote. Details: ${message}`,
      name: "github",
      ok: false,
      required: false,
    };
  }
}

function summarize(checks: AutoReadinessCheck[]) {
  const firstBlockingCheck = checks.find((check) => check.required && !check.ok);

  if (firstBlockingCheck) {
    return firstBlockingCheck.message;
  }

  return "Auto is ready to run in an isolated project copy.";
}

export async function getAutoReadiness(input: {
  presetId?: string | null;
  projectId: string;
  runCommand?: CommandRunner;
}): Promise<AutoReadiness | null> {
  const project = getProject(input.projectId);

  if (!project) {
    return null;
  }

  const preset = input.presetId ? getMiniPreset(input.presetId) : null;
  const snapshot =
    preset?.config ?? createRecommendedMiniPresetSnapshot(project.workspacePath);
  const runCommand = input.runCommand ?? defaultRunner;
  const checks = [
    await gitCheck(project.workspacePath, runCommand),
    await dockerCheck(snapshot, runCommand),
    runtimeCheck(),
    await miniCheck(runCommand),
    modelCheck(snapshot),
    await githubCheck(project.workspacePath, runCommand),
  ];

  return {
    canCreateRun: checks.every((check) => check.ok || !check.required),
    checks,
    dockerImage: snapshot.dockerImage ?? null,
    environment: snapshot.environment ?? "docker",
    environmentKind: snapshot.environmentKind ?? null,
    message: summarize(checks),
    modelName: snapshot.modelName ?? null,
  };
}

export const __autoReadinessTestInternals = {
  dockerCheck,
  gitCheck,
  modelCheck,
};
