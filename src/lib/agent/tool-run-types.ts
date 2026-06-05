import type {
  AgentTool,
  ToolExecutionInput,
  ToolRun as ToolRunBase,
} from "@/lib/tools/types";
import type { LlmMessage } from "@/lib/agent/model-client";

export type DirectToolPlan = {
  id: string;
  input: ToolExecutionInput;
  name: string;
};

export type ToolRun = ToolRunBase & {
  assistantMessage: LlmMessage;
  durationMs?: number;
  finishedAt?: number;
  startedAt?: number;
  tool: AgentTool;
  toolCallId: string;
};

export const APPROVE_WRITE_COMMAND = "APPROVE_WRITE";
export const CANCEL_WRITE_COMMAND = "CANCEL_WRITE";

function readMaxToolCalls() {
  const rawValue = process.env.AGENT_MAX_TOOL_CALLS?.trim();
  if (!rawValue || !/^\d+$/.test(rawValue)) {
    return 8;
  }

  const parsedValue = Number(rawValue);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : 8;
}

export const MAX_TOOL_CALLS = readMaxToolCalls();

export function normalizeMaxToolCalls(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return null;
  }

  return value;
}

export function getEffectiveMaxToolCalls(
  sessionContext?: { maxToolCalls?: number | null },
) {
  return normalizeMaxToolCalls(sessionContext?.maxToolCalls) ?? MAX_TOOL_CALLS;
}

export function createSyntheticToolCallId() {
  return `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
