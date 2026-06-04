import { NextResponse } from "next/server";
import { listToolRuns } from "@/lib/db/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  return NextResponse.json({
    toolRuns: listToolRuns(sessionId),
  });
}
