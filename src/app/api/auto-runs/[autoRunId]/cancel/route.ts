import { NextResponse } from "next/server";
import { requestAutoRunCancel } from "@/lib/db/auto-store";
import { requestAutoWorkerCancel } from "@/lib/auto/worker";
import type { AutoRunCancelRequest } from "@/types/auto";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ autoRunId: string }> },
) {
  const { autoRunId } = await context.params;
  let body: Partial<AutoRunCancelRequest> = {};

  try {
    body = (await request.json()) as Partial<AutoRunCancelRequest>;
  } catch {
    body = {};
  }

  const run = requestAutoRunCancel(
    autoRunId,
    typeof body.reason === "string" ? body.reason : undefined,
  );

  if (!run) {
    return NextResponse.json(
      { error: "Auto Run was not found." },
      { status: 404 },
    );
  }

  requestAutoWorkerCancel(autoRunId);

  return NextResponse.json({ run });
}
