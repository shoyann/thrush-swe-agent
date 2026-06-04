import path from "node:path";
import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
  WriteFileDraft,
} from "@/lib/tools/types";
import { getWorkspaceRoot, resolveWorkspacePath } from "@/lib/tools/workspace-path";

function createDraftId() {
  return `draft-${Date.now()}`;
}

function parseTagBlock(text: string, tagName: string, trim = true) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);

  if (!match) {
    return null;
  }

  return trim ? match[1].trim() : match[1];
}

function parseWriteFileObjectInput(input: ToolCallArgs) {
  const filePath = typeof input.path === "string" ? input.path.trim() : "";
  const fileContent = typeof input.content === "string" ? input.content : null;

  if (!filePath) {
    return {
      ok: false,
      message: 'write_file input must include a non-empty "path" value.',
    } as const;
  }

  if (fileContent === null) {
    return {
      ok: false,
      message: 'write_file input must include a "content" value.',
    } as const;
  }

  return {
    ok: true,
    filePath,
    fileContent,
  } as const;
}

function parseWriteFileStringInput(input: string) {
  const filePath = parseTagBlock(input, "path");
  const fileContent = parseTagBlock(input, "content", false);

  if (!filePath) {
    return {
      ok: false,
      message: 'write_file input must include <path>relative/file.txt</path>.',
    } as const;
  }

  if (fileContent === null) {
    return {
      ok: false,
      message: "write_file input must include <content>...</content>.",
    } as const;
  }

  return {
    ok: true,
    filePath,
    fileContent,
  } as const;
}

function formatDraftContent(draft: WriteFileDraft) {
  const proposedContent = draft.content.length > 0 ? draft.content : "(empty file)";

  return [
    "Write file draft only. Nothing was written to disk.",
    `Draft id: ${draft.id}`,
    `Target path: ${draft.path}`,
    "----- Proposed content -----",
    proposedContent,
    "----- End draft -----",
    `Reply with APPROVE_WRITE ${draft.id} to write this file.`,
    `Reply with CANCEL_WRITE ${draft.id} to discard this draft.`,
  ].join("\n");
}

function parseWriteFileInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return parseWriteFileStringInput(input);
  }

  return parseWriteFileObjectInput(input);
}

async function executeWriteFile(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseWriteFileInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    const targetPath = resolveWorkspacePath(parsed.filePath);
    const relativePath =
      path.relative(getWorkspaceRoot(), targetPath).replace(/\\/g, "/") || ".";

    const draft: WriteFileDraft = {
      id: createDraftId(),
      kind: "write_file",
      path: relativePath,
      content: parsed.fileContent,
    };

    return {
      ok: true,
      content: formatDraftContent(draft),
      draft,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The write_file draft could not be prepared.";

    return {
      ok: false,
      content: message,
    };
  }
}

export const writeFileTool: AgentTool = {
  name: "write_file",
  description:
    "Prepare a file write draft inside the configured workspace root only. Input format: <path>relative/file.txt</path><content>file text</content>. This tool never writes to disk.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Required file path relative to the configured workspace root for the draft target.",
      },
      content: {
        type: "string",
        description: "Required full file content to place in the draft.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  execute: executeWriteFile,
  onResult(_goal, result) {
    return result.draft
      ? {
          type: "immediate",
          message: result.content,
        }
      : null;
  },
};
