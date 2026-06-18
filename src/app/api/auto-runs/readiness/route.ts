import { NextResponse } from "next/server";
import { getAutoReadiness } from "@/lib/auto/readiness";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.trim();
  const presetId = url.searchParams.get("presetId")?.trim() || null;

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required." },
      { status: 400 },
    );
  }

  const readiness = await getAutoReadiness({ presetId, projectId });

  if (!readiness) {
    return NextResponse.json(
      { error: "Project was not found." },
      { status: 404 },
    );
  }

  return NextResponse.json({ readiness });
}
