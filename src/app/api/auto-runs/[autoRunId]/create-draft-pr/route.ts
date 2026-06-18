import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  appendAutoEvent,
  getAutoRun,
  recordDraftPrUrl,
} from "@/lib/db/auto-store";

const execFileAsync = promisify(execFile);
const GH_CLI_EXECUTABLE = process.env.GH_PATH?.trim() || "gh";

export const runtime = "nodejs";

async function runGh(args: string[], cwd: string) {
  const { stdout } = await execFileAsync(GH_CLI_EXECUTABLE, args, {
    cwd,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });

  return stdout.trim();
}

export async function POST(
  request: Request,
  context: { params: Promise<{ autoRunId: string }> },
) {
  const { autoRunId } = await context.params;
  const run = getAutoRun(autoRunId);

  if (!run) {
    return NextResponse.json(
      { error: "Auto Run was not found." },
      { status: 404 },
    );
  }

  if (run.status !== "completed") {
    return NextResponse.json(
      { error: "Draft PR can only be created after a completed Auto Run." },
      { status: 400 },
    );
  }

  if (!run.worktreePath || !run.branchName) {
    return NextResponse.json(
      { error: "This Auto Run does not have a worktree branch to push." },
      { status: 400 },
    );
  }

  try {
    await runGh(["auth", "status"], run.worktreePath);
    await execFileAsync("git", ["push", "-u", "origin", run.branchName], {
      cwd: run.worktreePath,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const title = `Auto: ${run.task.slice(0, 72)}`;
    const body = [
      "Created by Thrush Auto Mode.",
      "",
      "Review the Auto Report and diff before marking this PR ready.",
    ].join("\n");
    const url = await runGh(
      ["pr", "create", "--draft", "--title", title, "--body", body],
      run.worktreePath,
    );

    recordDraftPrUrl(autoRunId, url);
    appendAutoEvent({
      autoRunId,
      data: { url },
      message: "GitHub Draft PR created.",
      type: "draft_pr_created",
    });

    return NextResponse.json({ url });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "GitHub Draft PR could not be created.";

    appendAutoEvent({
      autoRunId,
      data: { message },
      message: "GitHub Draft PR creation failed.",
      type: "draft_pr_failed",
    });

    return NextResponse.json(
      {
        error:
          "GitHub Draft PR could not be created. Check GitHub CLI authentication and repository remote settings.",
        detail: message,
      },
      { status: 400 },
    );
  }
}
