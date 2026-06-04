import type { ToolCallArgs, ToolExecutionInput } from "@/lib/tools/types";
import type { ToolRun } from "@/lib/agent/tool-run-types";

export function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function getStringArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export function getStringArrayArg(args: ToolCallArgs, key: string) {
  const value = args[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function getNumberArg(args: ToolCallArgs, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getToolPathReference(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input.trim() || null;
  }

  return getStringArg(input, "path") || null;
}

export function formatToolExecutionInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input;
  }

  return JSON.stringify(input);
}

export function formatToolRunsForModel(toolRuns: ToolRun[]) {
  return toolRuns
    .map((toolRun, index) =>
      [
        `Tool result ${index + 1}:`,
        `name: ${toolRun.name}`,
        `input: ${toolRun.inputText}`,
        `ok: ${toolRun.result.ok ? "true" : "false"}`,
        "content:",
        toolRun.result.content,
      ].join("\n"),
    )
    .join("\n\n");
}
