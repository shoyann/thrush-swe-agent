import type { AgentSessionContext } from "@/types/agent";
import { getToolPathReference } from "@/lib/agent/tool-args";
import type { ToolRun } from "@/lib/agent/tool-run-types";

export function formatSessionContextForModel(
  sessionContext: AgentSessionContext,
) {
  const lines = [
    `Read-only mode: ${sessionContext.readOnly ? "on" : "off"}`,
    `Last tool name: ${sessionContext.lastToolName ?? "none"}`,
    `Last tool input: ${sessionContext.lastToolInput ?? "none"}`,
    `Last listed directory: ${sessionContext.lastListedDirectoryPath ?? "none"}`,
    `Last read file: ${sessionContext.lastReadFilePath ?? "none"}`,
  ];

  if (sessionContext.pendingDraft) {
    lines.push(`Pending draft id: ${sessionContext.pendingDraft.id}`);
    lines.push(`Pending draft path: ${sessionContext.pendingDraft.path}`);
    lines.push("Pending draft content:");
    lines.push(sessionContext.pendingDraft.content || "(empty file)");
  } else {
    lines.push("Pending draft id: none");
  }

  if (sessionContext.pendingWorkspaceSwitch) {
    lines.push(`Pending workspace switch id: ${sessionContext.pendingWorkspaceSwitch.id}`);
    lines.push(
      `Pending workspace switch path: ${sessionContext.pendingWorkspaceSwitch.workspacePath}`,
    );
  } else {
    lines.push("Pending workspace switch id: none");
  }

  lines.push(
    "Reference rules: if the user says 'that draft', prefer the pending draft. If the user says 'that file', prefer the pending draft path first, then the last read file. If the user says 'continue the last step', prefer continuing the pending draft flow; otherwise use the last tool context.",
  );

  return lines.join("\n");
}

export function buildNextSessionContext(
  previousContext: AgentSessionContext,
  toolRuns: ToolRun[],
): AgentSessionContext {
  const nextContext: AgentSessionContext = {
    ...previousContext,
  };

  for (const toolRun of toolRuns) {
    nextContext.lastToolName = toolRun.name;
    nextContext.lastToolInput = toolRun.inputText;

    if (toolRun.name === "list_files") {
      nextContext.lastListedDirectoryPath = getToolPathReference(toolRun.input);
    }

    if (toolRun.name === "read_file") {
      nextContext.lastReadFilePath = getToolPathReference(toolRun.input);
    }

    if (toolRun.result.draft) {
      nextContext.pendingDraft = toolRun.result.draft;
    }
  }

  return nextContext;
}
