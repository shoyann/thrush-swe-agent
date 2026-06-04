import { NextResponse } from "next/server";
import { getSession } from "@/lib/db/store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
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
