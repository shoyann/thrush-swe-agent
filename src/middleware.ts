import { NextRequest, NextResponse } from "next/server";
export function middleware(request: NextRequest) {
  const desktop = process.env.THRUSH_DESKTOP === "1";
  if (request.nextUrl.pathname.startsWith("/api/desktop") && !desktop) {
    return NextResponse.json({ error: "Desktop only." }, { status: 404 });
  }
  if (
    desktop &&
    (!process.env.AGENT_API_SECRET ||
      request.headers.get("authorization") !==
        `Bearer ${process.env.AGENT_API_SECRET}`)
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  return NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
