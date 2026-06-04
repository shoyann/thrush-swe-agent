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
export const MAX_TOOL_CALLS = 4;

export function createSyntheticToolCallId() {
  return `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
