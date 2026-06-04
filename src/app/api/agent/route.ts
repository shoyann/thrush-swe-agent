import { NextResponse } from "next/server";
import { runAgent } from "@/lib/agent/run-agent";
import {
  appendMessage,
  createCheckpoint,
  getSessionProject,
  recordToolRun,
  updateSessionState,
} from "@/lib/db/store";
import { createLogger } from "@/lib/logger";
import { withWorkspaceRoot } from "@/lib/tools/workspace-path";
import type { AgentRequest, AgentStreamEvent } from "@/types/agent";

const encoder = new TextEncoder();
export const runtime = "nodejs";

function serializeStreamEvent(event: AgentStreamEvent | { type: "error"; message: string }) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  const agentApiSecret = process.env.AGENT_API_SECRET?.trim();
  const authorization = request.headers.get("authorization");

  if (!agentApiSecret) {
    console.warn(
      "AGENT_API_SECRET is not set. Rejecting /api/agent requests until server-side auth is configured.",
    );

    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (authorization !== `Bearer ${agentApiSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const requestId = "req_" + Math.random().toString(36).slice(2, 8);
  const logger = createLogger(requestId);
  const startTime = Date.now();

  logger.info("agent request received", { path: "/api/agent" });

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

  const sessionId = body.sessionId?.trim();
  if (!sessionId) {
    return NextResponse.json(
      { error: "sessionId is required." },
      { status: 400 },
    );
  }

  const sessionProject = getSessionProject(sessionId);
  if (!sessionProject) {
    return NextResponse.json(
      { error: "Session was not found." },
      { status: 404 },
    );
  }

  const { project, session } = sessionProject;
  const userMessage = appendMessage({
    content: task,
    role: "user",
    sessionId,
  });
  const messagesForAgent = [...session.messages, userMessage];
  const sessionContext = {
    ...session.sessionContext,
    projectId: project.id,
    sessionId,
  };

  createCheckpoint({
    data: {
      task,
      projectId: project.id,
      workspacePath: project.workspacePath,
    },
    kind: "agent_started",
    requestId,
    sessionId,
  });

  if (body.stream) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const result = await withWorkspaceRoot(project.workspacePath, () =>
            runAgent(task, messagesForAgent, sessionContext, requestId, {
              onEvent(event) {
                controller.enqueue(serializeStreamEvent(event));
              },
              onToolRun(toolRun) {
                recordToolRun({
                  requestId,
                  sessionId,
                  toolRun,
                });
                createCheckpoint({
                  data: toolRun,
                  kind: "tool_completed",
                  requestId,
                  sessionId,
                });
              },
              projectId: project.id,
              sessionId,
              workspaceRoot: project.workspacePath,
            }),
          );

          appendMessage({
            content: result.message.content,
            reasoningContent: result.message.reasoning_content ?? null,
            role: "assistant",
            sessionId,
          });
          updateSessionState(sessionId, result.sessionContext, result.steps);
          createCheckpoint({
            data: {
              sessionContext: result.sessionContext,
              steps: result.steps,
            },
            kind: "agent_finished",
            requestId,
            sessionId,
          });
          logger.info("agent request completed", {
            durationMs: Date.now() - startTime,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "The agent request failed.";

          logger.error("agent request failed", { error: message });

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
    const result = await withWorkspaceRoot(
      project.workspacePath,
      () =>
        runAgent(task, messagesForAgent, sessionContext, requestId, {
          onToolRun(toolRun) {
            recordToolRun({
              requestId,
              sessionId,
              toolRun,
            });
          },
          projectId: project.id,
          sessionId,
          workspaceRoot: project.workspacePath,
        }),
    );
    appendMessage({
      content: result.message.content,
      reasoningContent: result.message.reasoning_content ?? null,
      role: "assistant",
      sessionId,
    });
    updateSessionState(sessionId, result.sessionContext, result.steps);
    createCheckpoint({
      data: {
        sessionContext: result.sessionContext,
        steps: result.steps,
      },
      kind: "agent_finished",
      requestId,
      sessionId,
    });
    logger.info("agent request completed", {
      durationMs: Date.now() - startTime,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The agent request failed.";

    logger.error("agent request failed", { error: message });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
