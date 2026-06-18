import { NextResponse } from "next/server";
import {
  createAutoRun,
  listAutoRuns,
  listMiniPresets,
} from "@/lib/db/auto-store";
import { getAutoReadiness } from "@/lib/auto/readiness";
import { ensureAutoWorkerStarted } from "@/lib/auto/worker";
import type { AutoRunCreateRequest } from "@/types/auto";

export const runtime = "nodejs";

export async function GET(request: Request) {
  ensureAutoWorkerStarted();

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.trim();

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    presets: listMiniPresets(projectId),
    runs: listAutoRuns(projectId),
  });
}

export async function POST(request: Request) {
  let body: Partial<AutoRunCreateRequest>;

  try {
    body = (await request.json()) as Partial<AutoRunCreateRequest>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const task = typeof body.task === "string" ? body.task.trim() : "";

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required." },
      { status: 400 },
    );
  }

  if (!task) {
    return NextResponse.json(
      { error: "Task is required." },
      { status: 400 },
    );
  }

  try {
    const presetId = typeof body.presetId === "string" ? body.presetId : null;
    const readiness = await getAutoReadiness({ presetId, projectId });

    if (!readiness) {
      return NextResponse.json(
        { error: "Project was not found." },
        { status: 404 },
      );
    }

    if (!readiness.canCreateRun) {
      return NextResponse.json(
        {
          checks: readiness.checks,
          error: readiness.message,
        },
        { status: 400 },
      );
    }

    const run = createAutoRun({
      presetId,
      projectId,
      sourceRunId: typeof body.sourceRunId === "string" ? body.sourceRunId : null,
      sourceSessionId:
        typeof body.sourceSessionId === "string" ? body.sourceSessionId : null,
      task,
    });

    ensureAutoWorkerStarted();

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Auto Run could not be created.",
      },
      { status: 400 },
    );
  }
}
