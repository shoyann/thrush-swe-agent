import { NextResponse } from "next/server";
import { createProject, ensureWorkbench } from "@/lib/db/store";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(ensureWorkbench());
}

export async function POST(request: Request) {
  let body: {
    confirmWorkspace?: unknown;
    name?: unknown;
    workspacePath?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const workspacePath =
    typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";

  if (!workspacePath) {
    return NextResponse.json(
      { error: "workspacePath is required." },
      { status: 400 },
    );
  }

  try {
    const project = createProject({
      confirmWorkspace: body.confirmWorkspace === true,
      name: typeof body.name === "string" ? body.name : "",
      workspacePath,
    });

    return NextResponse.json({
      project,
      snapshot: ensureWorkbench(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project could not be created." },
      { status: 400 },
    );
  }
}
