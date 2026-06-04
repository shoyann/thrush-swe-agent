import { getTool } from "@/lib/tools/tool-registry";
import type { ToolExecutionInput } from "@/lib/tools/types";
import { formatToolExecutionInput } from "@/lib/agent/tool-args";
import type { LlmMessage } from "@/lib/agent/model-client";
import type { ToolRun } from "@/lib/agent/tool-run-types";

export async function runToolCall(
  toolName: string,
  toolInput: ToolExecutionInput,
  toolCallId: string,
  assistantMessage: LlmMessage,
): Promise<ToolRun> {
  const tool = getTool(toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" is not registered.`);
  }

  const result = await tool.execute(toolInput);
  const inputText = formatToolExecutionInput(toolInput);

  return {
    assistantMessage,
    name: toolName,
    input: toolInput,
    inputText,
    result,
    toolCallId,
  };
}
