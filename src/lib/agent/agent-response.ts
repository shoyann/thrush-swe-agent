import type {
  AgentResponse,
  AgentStep,
  AgentStreamEvent,
  ChatMessage,
} from "@/types/agent";
import type { ToolRun } from "@/lib/agent/tool-run-types";

export type RunAgentOptions = {
  disableTaskPlanning?: boolean;
  emitFinalEvents?: boolean;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  onToolRun?: (toolRun: ToolRun) => void | Promise<void>;
  projectId?: string;
  sessionId?: string;
  workspaceRoot?: string;
};

export function createStep(id: string, title: string, detail: string): AgentStep {
  return {
    id,
    title,
    detail,
    status: "done",
  };
}

export function createMessage(
  content: string,
  reasoningContent?: string | null,
): ChatMessage {
  return {
    id: `assistant-${Date.now()}`,
    role: "assistant",
    content,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
  };
}

function cloneSteps(steps: AgentStep[]) {
  return steps.map((step) => ({ ...step }));
}

export async function emitAgentEvent(
  onEvent: RunAgentOptions["onEvent"],
  event: AgentStreamEvent,
) {
  if (!onEvent) {
    return;
  }

  await onEvent(event);
}

export async function emitStepsSnapshot(
  steps: AgentStep[],
  onEvent: RunAgentOptions["onEvent"],
) {
  await emitAgentEvent(onEvent, {
    type: "steps",
    steps: cloneSteps(steps),
  });
}

export async function finishAgentRun(
  response: AgentResponse,
  onEvent: RunAgentOptions["onEvent"],
  includeSteps: boolean,
  emitFinalEvents = true,
) {
  if (includeSteps) {
    await emitStepsSnapshot(response.steps, onEvent);
  }

  if (!emitFinalEvents) {
    return response;
  }

  await emitAgentEvent(onEvent, {
    type: "message",
    message: response.message,
  });
  await emitAgentEvent(onEvent, {
    type: "done",
    sessionContext: response.sessionContext,
  });

  return response;
}
