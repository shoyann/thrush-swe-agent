import { NextResponse } from "next/server";

export function requireAgentApiAuth(request: Request) {
  const agentApiSecret = process.env.AGENT_API_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!agentApiSecret) {
    console.warn(
      "AGENT_API_SECRET is not set. Rejecting API requests until server-side auth is configured.",
    );

    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (authorization !== `Bearer ${agentApiSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}
