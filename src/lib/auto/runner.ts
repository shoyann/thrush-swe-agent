import { spawn, execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AutoFailureCategory, AutoMiniExitStatus, AutoRun } from "@/types/auto";
import {
  appendAutoEvent,
  createAutoArtifact,
  finishAutoRun,
  getAutoRun,
  markAutoRunStatus,
  updateAutoRunPaths,
} from "@/lib/db/auto-store";
import { generateAutoReport } from "@/lib/auto/report";
import { resolveMiniCommand } from "@/lib/auto/mini-resolver";
import { getMiniRuntimeStatus } from "./mini-runtime";
import { getMiniFailure, parseMiniExitStatus } from "@/lib/auto/mini-status";

const execFileAsync = promisify(execFile);
const MAX_INLINE_ARTIFACT_LENGTH = 120_000;
const LOG_TAIL_LENGTH = 10_000;

type RunningProcess = {
  kill: () => void;
};

const runningProcesses = new Map<string, RunningProcess>();

function shouldUseShellForCommand(command: string) {
  return process.platform === "win32" && /\.(bat|cmd)$/i.test(command);
}

function getRunRoot(autoRunId: string) {
  return path.resolve(process.cwd(), "data", "auto-runs", autoRunId);
}

function getArtifactsRoot(autoRunId: string) {
  return path.join(getRunRoot(autoRunId), "artifacts");
}

function getWorktreePath(autoRunId: string) {
  return path.join(getRunRoot(autoRunId), "worktree");
}

async function execGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });

  return stdout.trim();
}

async function getGitOutput(args: string[], cwd: string) {
  try {
    return await execGit(args, cwd);
  } catch {
    return "";
  }
}

async function assertCleanWorkspace(run: AutoRun) {
  const status = await execGit(["status", "--porcelain"], run.workspacePath);

  if (status.trim()) {
    throw Object.assign(
      new Error(
        "Your project has uncommitted changes. Auto needs a clean starting point so its result does not mix with unfinished local work.",
      ),
      { category: "workspace_dirty" satisfies AutoFailureCategory },
    );
  }
}

async function prepareWorktree(run: AutoRun) {
  const worktreePath = getWorktreePath(run.id);
  const branchName = `auto/${run.id}`;
  const baseCommitSha = await execGit(["rev-parse", "HEAD"], run.workspacePath);

  mkdirSync(path.dirname(worktreePath), { recursive: true });
  rmSync(worktreePath, { force: true, recursive: true });
  await execGit(["worktree", "prune"], run.workspacePath);
  await execGit(["worktree", "add", "-B", branchName, worktreePath, "HEAD"], run.workspacePath);

  updateAutoRunPaths({
    autoRunId: run.id,
    baseCommitSha,
    branchName,
    worktreePath,
  });

  return {
    baseCommitSha,
    branchName,
    worktreePath,
  };
}

function buildDockerRunArgs(worktreePath: string, networkPolicy: string | undefined) {
  const args = ["--rm", "-v", `${worktreePath}:/workspace`];

  if (networkPolicy === "none") {
    args.push("--network", "none");
  }

  return args;
}

function buildMiniArgs(run: AutoRun, worktreePath: string, trajectoryPath: string) {
  if (!process.env.AUTO_RUN_MINI_COMMAND?.trim()) {
    const runtime = getMiniRuntimeStatus();

    if (!runtime.ready) {
      throw Object.assign(new Error(runtime.message), {
        category: "mini_unavailable" satisfies AutoFailureCategory,
      });
    }
  }

  const mini = resolveMiniCommand();
  const snapshot = run.presetSnapshot;
  const dockerImage = snapshot.dockerImage ?? "debian:bookworm";
  const costLimit = snapshot.costLimit ?? 3;
  const stepLimit = snapshot.stepLimit ?? 0;
  const wallTimeLimitSeconds = snapshot.wallTimeLimitSeconds ?? 3600;
  const environment = snapshot.environment ?? "docker";
  const args = [
    ...mini.argsPrefix,
    "-c",
    "mini.yaml",
    "-c",
    `agent.cost_limit=${JSON.stringify(costLimit)}`,
    "-c",
    `agent.step_limit=${JSON.stringify(stepLimit)}`,
    "-c",
    `agent.wall_time_limit_seconds=${JSON.stringify(wallTimeLimitSeconds)}`,
    "-c",
    `environment.environment_class=${JSON.stringify(environment)}`,
    "-c",
    `environment.cwd=${JSON.stringify(environment === "docker" ? "/workspace" : worktreePath)}`,
    "-c",
    `environment.timeout=${JSON.stringify(120)}`,
    "-o",
    trajectoryPath,
    "-y",
    "-t",
    run.task,
  ];

  if (snapshot.modelName) {
    args.push("-m", snapshot.modelName);
  }

  if (environment === "docker") {
    args.push(
      "-c",
      `environment.image=${JSON.stringify(dockerImage)}`,
      "-c",
      `environment.run_args=${JSON.stringify(buildDockerRunArgs(worktreePath, snapshot.networkPolicy))}`,
    );
  }

  return {
    args,
    command: mini.command,
    env: mini.env,
    source: mini.source,
  };
}

async function runMini(run: AutoRun, worktreePath: string, artifactsRoot: string) {
  const logPath = path.join(artifactsRoot, "mini.log");
  const trajectoryPath = path.join(artifactsRoot, "trajectory.json");
  const miniCommand = buildMiniArgs(run, worktreePath, trajectoryPath);

  appendAutoEvent({
    autoRunId: run.id,
    data: { source: miniCommand.source },
    message: `Starting mini-swe-agent through ${miniCommand.source}.`,
    type: "mini_started",
  });

  return await new Promise<{
    exitCode: number;
    logText: string;
    miniExitStatus: AutoMiniExitStatus;
  }>((resolve, reject) => {
    let logText = "";
    const child = spawn(miniCommand.command, miniCommand.args, {
      cwd: worktreePath,
      env: {
        ...process.env,
        ...miniCommand.env,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
        PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
        UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT ?? "300",
      },
      shell: shouldUseShellForCommand(miniCommand.command),
      windowsHide: true,
    });

    runningProcesses.set(run.id, {
      kill() {
        child.kill("SIGTERM");
      },
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logText += text;
      writeFileSync(logPath, logText);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logText += text;
      writeFileSync(logPath, logText);
    });

    child.on("error", (error) => {
      runningProcesses.delete(run.id);
      reject(
        Object.assign(
          new Error(
            `mini-swe-agent could not be started. ${error.message}. Run npm run bootstrap:mini or install uv.`,
          ),
          { category: "mini_unavailable" satisfies AutoFailureCategory },
        ),
      );
    });

    child.on("close", (code) => {
      runningProcesses.delete(run.id);
      writeFileSync(logPath, logText);
      resolve({
        exitCode: code ?? -1,
        logText,
        miniExitStatus: parseMiniExitStatus(trajectoryPath),
      });
    });
  });
}

function inlineOrFileContent(filePath: string) {
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length <= MAX_INLINE_ARTIFACT_LENGTH ? text : null;
  } catch {
    return null;
  }
}

async function createArtifacts(input: {
  autoRunId: string;
  artifactsRoot: string;
  changedFiles: string;
  diff: string;
  diffStat: string;
  logText: string;
  report: string;
}) {
  const diffPath = path.join(input.artifactsRoot, "diff.patch");
  const diffStatPath = path.join(input.artifactsRoot, "diff-stat.txt");
  const changedFilesPath = path.join(input.artifactsRoot, "changed-files.txt");
  const reportPath = path.join(input.artifactsRoot, "report.md");
  const logPath = path.join(input.artifactsRoot, "mini.log");
  const trajectoryPath = path.join(input.artifactsRoot, "trajectory.json");

  writeFileSync(diffPath, input.diff);
  writeFileSync(diffStatPath, input.diffStat);
  writeFileSync(changedFilesPath, input.changedFiles);
  writeFileSync(reportPath, input.report);
  writeFileSync(logPath, input.logText);

  const reportArtifactId = createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: input.report,
    filePath: reportPath,
    label: "Auto Report",
    type: "report",
  });
  const diffArtifactId = createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: input.diff.length <= MAX_INLINE_ARTIFACT_LENGTH ? input.diff : null,
    filePath: diffPath,
    label: "Diff",
    type: "diff",
  });

  createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: input.diffStat,
    filePath: diffStatPath,
    label: "Diff Stat",
    type: "diff_stat",
  });
  createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: input.changedFiles,
    filePath: changedFilesPath,
    label: "Changed Files",
    type: "changed_files",
  });
  createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: input.logText.length <= MAX_INLINE_ARTIFACT_LENGTH ? input.logText : null,
    filePath: logPath,
    label: "mini-swe-agent Logs",
    type: "logs",
  });
  createAutoArtifact({
    autoRunId: input.autoRunId,
    contentText: inlineOrFileContent(trajectoryPath),
    filePath: trajectoryPath,
    label: "mini-swe-agent Trajectory",
    type: "trajectory",
  });

  return {
    diffArtifactId,
    reportArtifactId,
  };
}

function getErrorCategory(error: unknown): AutoFailureCategory {
  const category = (error as { category?: unknown })?.category;
  return typeof category === "string" ? (category as AutoFailureCategory) : "unknown";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The Auto Run failed for an unknown reason.";
}

export function cancelRunningAutoRun(autoRunId: string) {
  runningProcesses.get(autoRunId)?.kill();
}

export async function runAutoRun(autoRunId: string) {
  let run = getAutoRun(autoRunId);

  if (!run) {
    return;
  }

  const artifactsRoot = getArtifactsRoot(run.id);
  mkdirSync(artifactsRoot, { recursive: true });

  try {
    appendAutoEvent({
      autoRunId: run.id,
      message: "Checking that the main workspace is clean.",
      type: "workspace_check",
    });
    await assertCleanWorkspace(run);

    const current = getAutoRun(run.id);
    if (current?.cancelRequested) {
      throw Object.assign(new Error("The Auto Run was canceled before mini-swe-agent started."), {
        category: "canceled" satisfies AutoFailureCategory,
      });
    }

    appendAutoEvent({
      autoRunId: run.id,
      message: "Creating an isolated worktree for Auto.",
      type: "worktree_preparing",
    });
    const prepared = await prepareWorktree(run);
    markAutoRunStatus({ autoRunId: run.id, status: "running" });

    run = getAutoRun(run.id) ?? run;
    const miniResult = await runMini(run, prepared.worktreePath, artifactsRoot);
    const latest = getAutoRun(run.id);

    if (latest?.cancelRequested) {
      throw Object.assign(new Error("The Auto Run was canceled."), {
        category: "canceled" satisfies AutoFailureCategory,
      });
    }

    appendAutoEvent({
      autoRunId: run.id,
      data: { exitCode: miniResult.exitCode },
      message: "mini-swe-agent finished. Collecting artifacts.",
      type: "mini_finished",
    });

    const diff = await getGitOutput(["diff", "HEAD"], prepared.worktreePath);
    const diffStat = await getGitOutput(["diff", "--stat", "HEAD"], prepared.worktreePath);
    const changedFiles = await getGitOutput(["diff", "--name-only", "HEAD"], prepared.worktreePath);
    const headCommitSha = await getGitOutput(["rev-parse", "HEAD"], prepared.worktreePath);
    updateAutoRunPaths({
      autoRunId: run.id,
      headCommitSha,
    });

    markAutoRunStatus({ autoRunId: run.id, status: "reporting" });
    const status =
      miniResult.exitCode === 0 && miniResult.miniExitStatus === "Submitted"
        ? "completed"
        : "failed";
    const failure =
      status === "failed"
        ? getMiniFailure({
            exitCode: miniResult.exitCode,
            logText: miniResult.logText,
            miniExitStatus: miniResult.miniExitStatus,
          })
        : null;
    const report = await generateAutoReport({
      changedFiles,
      diffStat,
      failureCategory: failure?.category ?? null,
      failureMessage: failure?.message ?? null,
      logsTail: miniResult.logText.slice(-LOG_TAIL_LENGTH),
      run,
      status,
    });
    const artifactIds = await createArtifacts({
      autoRunId: run.id,
      artifactsRoot,
      changedFiles,
      diff,
      diffStat,
      logText: miniResult.logText,
      report,
    });

    finishAutoRun({
      autoRunId: run.id,
      diffArtifactId: artifactIds.diffArtifactId,
      exitCode: miniResult.exitCode,
      headCommitSha,
      reportArtifactId: artifactIds.reportArtifactId,
      resultStatus: miniResult.miniExitStatus,
      status,
    });
    if (failure) {
      markAutoRunStatus({
        autoRunId: run.id,
        failureCategory: failure.category,
        failureMessage: failure.message,
        status,
      });
    }
    appendAutoEvent({
      autoRunId: run.id,
      data: { exitCode: miniResult.exitCode, miniExitStatus: miniResult.miniExitStatus },
      message:
        status === "completed"
          ? "Auto Run completed. Review the report and diff before taking the next step."
          : "Auto Run failed. Review the report for the specific reason and next step.",
      type: status,
    });
  } catch (error) {
    const category = getErrorCategory(error);
    const status = category === "canceled" ? "canceled" : "failed";
    const message = getErrorMessage(error);
    markAutoRunStatus({
      autoRunId: run.id,
      failureCategory: category,
      failureMessage: message,
      resultStatus: status,
      status,
    });
    const report = await generateAutoReport({
      changedFiles: "",
      diffStat: "",
      failureCategory: category,
      failureMessage: message,
      logsTail: "",
      run,
      status,
    });
    const reportPath = path.join(artifactsRoot, "report.md");
    writeFileSync(reportPath, report);
    const reportArtifactId = createAutoArtifact({
      autoRunId: run.id,
      contentText: report,
      filePath: reportPath,
      label: "Auto Report",
      type: "report",
    });
    finishAutoRun({
      autoRunId: run.id,
      reportArtifactId,
      resultStatus: status,
      status,
    });
    appendAutoEvent({
      autoRunId: run.id,
      data: { category },
      message,
      type: status,
    });
  }
}
