import { NextResponse } from "next/server";
import { getSession } from "@/lib/db/store";
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
  const session = getSession(sessionId);

  if (!session) {
    return NextResponse.json(
      { error: "Session was not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ session });
}
