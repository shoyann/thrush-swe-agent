import { NextResponse } from "next/server";
import {
  ensureWorkbench,
  updateSessionSettings,
} from "@/lib/db/store";
import { requireAgentApiAuth } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const unauthorized = requireAgentApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { sessionId } = await context.params;
  let body: { autoApprove?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  try {
    const session = updateSessionSettings(sessionId, {
      autoApprove:
        typeof body.autoApprove === "boolean" ? body.autoApprove : undefined,
    });

    return NextResponse.json({
      session,
      snapshot: ensureWorkbench(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Session settings could not be updated.",
      },
      { status: 400 },
    );
  }
}
