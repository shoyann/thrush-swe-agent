import { readFile } from "node:fs/promises";
import type {
  AgentTool,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { resolveWorkspacePath } from "@/lib/tools/workspace-path";

function parseReadFileInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return input.trim();
  }

  if (typeof input.path === "string") {
    return input.path.trim();
  }

  return "";
}

async function executeReadFile(input: ToolExecutionInput): Promise<ToolResult> {
  const filePath = parseReadFileInput(input);

  if (!filePath) {
    return {
      ok: false,
      content: "A file path is required.",
    };
  }

  try {
    const targetPath = resolveWorkspacePath(filePath);
    const fileContent = await readFile(targetPath, "utf8");

    return {
      ok: true,
      content: fileContent,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The file could not be read.";

    return {
      ok: false,
      content: message,
    };
  }
}

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read one UTF-8 text file from the configured workspace root.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Required file path relative to the configured workspace root.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: executeReadFile,
};
