import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentTool,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { getWorkspaceRoot, resolveWorkspacePath } from "@/lib/tools/workspace-path";

function parseListFilesInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input.trim() || ".";
  }

  if (typeof input.path === "string" && input.path.trim()) {
    return input.path.trim();
  }

  return ".";
}

async function executeListFiles(input: ToolExecutionInput): Promise<ToolResult> {
  try {
    const targetPath = resolveWorkspacePath(parseListFilesInput(input));
    const entries = await readdir(targetPath, { withFileTypes: true });
    const relativePath = path.relative(getWorkspaceRoot(), targetPath) || ".";
    const workspaceRoot = getWorkspaceRoot().replace(/\\/g, "/");

    const lines = entries.map((entry) =>
      entry.isDirectory() ? `[dir] ${entry.name}` : `[file] ${entry.name}`,
    );

    return {
      ok: true,
      content: [
        `Workspace root: ${workspaceRoot}`,
        `Listing for ${relativePath}:`,
        ...lines,
      ].join("\n"),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The folder could not be listed.";

    return {
      ok: false,
      content: message,
    };
  }
}

export const listFilesTool: AgentTool = {
  name: "list_files",
  description: "List files and folders inside the configured workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional path relative to the configured workspace root. Defaults to the workspace root itself.",
      },
    },
    additionalProperties: false,
  },
  execute: executeListFiles,
};
