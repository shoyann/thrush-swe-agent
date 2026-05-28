import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/run-agent";
import type { AgentRequest, AgentStreamEvent } from "@/types/agent";

const encoder = new TextEncoder();

function serializeStreamEvent(event: AgentStreamEvent | { type: "error"; message: string }) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let body: AgentRequest;

  try {
    body = (await request.json()) as AgentRequest;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const task = body.task?.trim();
  if (!task) {
    return NextResponse.json(
      { error: "Task is required." },
      { status: 400 },
    );
  }

  if (body.stream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await runAgent(task, body.messages, body.sessionContext, {
            onEvent(event) {
              controller.enqueue(serializeStreamEvent(event));
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "The agent request failed.";

          controller.enqueue(
            serializeStreamEvent({
              type: "error",
              message,
            }),
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  }

  try {
    const result = await runAgent(task, body.messages, body.sessionContext);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The agent request failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
