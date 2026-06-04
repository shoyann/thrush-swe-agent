import { getTool, isReadOnlyBlockedTool } from "@/lib/tools/tool-registry";
import type { ToolExecutionInput } from "@/lib/tools/types";
import { formatToolExecutionInput } from "@/lib/agent/tool-args";
import type { LlmMessage } from "@/lib/agent/model-client";
import type { ToolRun } from "@/lib/agent/tool-run-types";

export async function runToolCall(
  toolName: string,
  toolInput: ToolExecutionInput,
  toolCallId: string,
  assistantMessage: LlmMessage,
  options: { readOnly?: boolean } = {},
): Promise<ToolRun> {
  const tool = getTool(toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" is not registered.`);
  }

  const startedAt = Date.now();
  const inputText = formatToolExecutionInput(toolInput);

  if (options.readOnly && isReadOnlyBlockedTool(toolName)) {
    const finishedAt = Date.now();

    return {
      assistantMessage,
      durationMs: finishedAt - startedAt,
      finishedAt,
      name: toolName,
      input: toolInput,
      inputText,
      result: {
        ok: false,
        content: [
          "Current session is read-only, so file modifications are disabled.",
          `Blocked tool: ${toolName}`,
          "Exit read-only mode before modifying files.",
        ].join("\n"),
      },
      startedAt,
      tool,
      toolCallId,
    };
  }

  const result = await tool.execute(toolInput);
  const finishedAt = Date.now();

  return {
    assistantMessage,
    durationMs: finishedAt - startedAt,
    finishedAt,
    name: toolName,
    input: toolInput,
    inputText,
    result,
    startedAt,
    tool,
    toolCallId,
  };
}
