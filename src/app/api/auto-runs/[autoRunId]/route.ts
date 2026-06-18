import { NextResponse } from "next/server";
import { getAutoRunDetail } from "@/lib/db/auto-store";
import { ensureAutoWorkerStarted } from "@/lib/auto/worker";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ autoRunId: string }> },
) {
  ensureAutoWorkerStarted();

  const { autoRunId } = await context.params;
  const detail = getAutoRunDetail(autoRunId);

  if (!detail) {
    return NextResponse.json(
      { error: "Auto Run was not found." },
      { status: 404 },
    );
  }

  return NextResponse.json(detail);
}
