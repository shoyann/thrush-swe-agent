import { readFile } from "node:fs/promises";
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

function parseReplaceTextObjectInput(input: ToolCallArgs) {
  const filePath = typeof input.path === "string" ? input.path.trim() : "";
  const oldText = typeof input.old_text === "string" ? input.old_text : null;
  const newText = typeof input.new_text === "string" ? input.new_text : null;

  if (!filePath) {
    return {
      ok: false,
      message: 'replace_text input must include a non-empty "path" value.',
    } as const;
  }

  if (oldText === null || oldText.length === 0) {
    return {
      ok: false,
      message: 'replace_text input must include a non-empty "old_text" value.',
    } as const;
  }

  if (newText === null) {
    return {
      ok: false,
      message: 'replace_text input must include a "new_text" value.',
    } as const;
  }

  return {
    ok: true,
    filePath,
    oldText,
    newText,
  } as const;
}

function parseReplaceTextStringInput(input: string) {
  const filePath = parseTagBlock(input, "path");
  const oldText = parseTagBlock(input, "old_text", false);
  const newText = parseTagBlock(input, "new_text", false);

  if (!filePath) {
    return {
      ok: false,
      message: 'replace_text input must include <path>relative/file.txt</path>.',
    } as const;
  }

  if (oldText === null || oldText.length === 0) {
    return {
      ok: false,
      message: "replace_text input must include <old_text>...</old_text>.",
    } as const;
  }

  if (newText === null) {
    return {
      ok: false,
      message: "replace_text input must include <new_text>...</new_text>.",
    } as const;
  }

  return {
    ok: true,
    filePath,
    oldText,
    newText,
  } as const;
}

function parseReplaceTextInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return parseReplaceTextStringInput(input);
  }

  return parseReplaceTextObjectInput(input);
}

function countExactMatches(content: string, oldText: string) {
  let count = 0;
  let startIndex = 0;

  while (true) {
    const matchIndex = content.indexOf(oldText, startIndex);

    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    startIndex = matchIndex + oldText.length;
  }
}

function formatDraftContent(
  draft: WriteFileDraft,
  oldText: string,
  newText: string,
) {
  const proposedContent = draft.content.length > 0 ? draft.content : "(empty file)";

  return [
    "Replace text draft only. Nothing was written to disk.",
    `Draft id: ${draft.id}`,
    `Target path: ${draft.path}`,
    "----- Matched old text -----",
    oldText,
    "----- Replacement text -----",
    newText || "(empty text)",
    "----- Proposed file content -----",
    proposedContent,
    "----- End draft -----",
    `Reply with APPROVE_WRITE ${draft.id} to write this file.`,
    `Reply with CANCEL_WRITE ${draft.id} to discard this draft.`,
  ].join("\n");
}

async function executeReplaceText(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseReplaceTextInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    const targetPath = resolveWorkspacePath(parsed.filePath);
    const originalContent = await readFile(targetPath, "utf8");
    const matchCount = countExactMatches(originalContent, parsed.oldText);

    if (matchCount === 0) {
      return {
        ok: false,
        content: [
          `replace_text could not find the requested old_text in "${parsed.filePath}".`,
          "Read the file again or use a more exact old_text snippet.",
        ].join("\n"),
      };
    }

    if (matchCount > 1) {
      return {
        ok: false,
        content: [
          `replace_text found ${matchCount} matches in "${parsed.filePath}".`,
          "Use a more specific old_text snippet so the change only hits one exact place.",
        ].join("\n"),
      };
    }

    const updatedContent = originalContent.replace(parsed.oldText, parsed.newText);
    const relativePath =
      path.relative(getWorkspaceRoot(), targetPath).replace(/\\/g, "/") || ".";

    const draft: WriteFileDraft = {
      id: createDraftId(),
      kind: "write_file",
      path: relativePath,
      content: updatedContent,
    };

    return {
      ok: true,
      content: formatDraftContent(draft, parsed.oldText, parsed.newText),
      draft,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The replace_text draft could not be prepared.";

    return {
      ok: false,
      content: message,
    };
  }
}

export const replaceTextTool: AgentTool = {
  name: "replace_text",
  description:
    "Prepare a draft by replacing one exact old_text snippet with new_text inside one existing file under the configured workspace root. This tool fails if old_text matches zero times or more than once. It never writes to disk.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Required file path relative to the configured workspace root.",
      },
      old_text: {
        type: "string",
        description:
          "Required exact existing text snippet to replace. The match must appear exactly once.",
      },
      new_text: {
        type: "string",
        description:
          "Required replacement text for that one exact snippet. Use an empty string to delete the matched text.",
      },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  execute: executeReplaceText,
  onResult(_goal, result) {
    return result.draft
      ? {
          type: "immediate",
          message: result.content,
        }
      : null;
  },
};
