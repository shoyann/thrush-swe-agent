import { NextResponse } from "next/server";
import { listToolRuns } from "@/lib/db/store";
import { requireAgentApiAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const unauthorized = requireAgentApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { sessionId } = await context.params;

  return NextResponse.json({
    toolRuns: listToolRuns(sessionId),
  });
}
