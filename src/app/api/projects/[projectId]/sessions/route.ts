import { NextResponse } from "next/server";
import { createSession, ensureWorkbench } from "@/lib/db/store";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  let body: { autoApprove?: unknown; title?: unknown } = {};

  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const session = createSession(
      projectId,
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : "New session",
      {
        autoApprove: body.autoApprove === true,
      },
    );

    return NextResponse.json({
      session,
      snapshot: ensureWorkbench(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Session could not be created." },
      { status: 400 },
    );
  }
}
