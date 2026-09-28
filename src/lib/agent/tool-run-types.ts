import { positiveLimit } from "./workflow";
import type { AgentTool, ToolRun as ToolRunBase } from "@/lib/tools/types";
import type { LlmMessage } from "@/lib/agent/model-client";

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

export const MAX_TOOL_CALLS = positiveLimit(
  process.env.AGENT_MAX_TOOL_CALLS,
  24,
  100,
);
export const MAX_RUN_MS = positiveLimit(
  process.env.AGENT_MAX_RUN_MS,
  600000,
  3600000,
);

export function createSyntheticToolCallId() {
  return `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
