import { readFile } from "node:fs/promises";
import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { resolveWorkspacePath } from "@/lib/tools/workspace-path";

const DEFAULT_MAX_LINES = 500;
const MAX_LINES_LIMIT = 1000;

type ParsedReadFileInput =
  | {
      ok: true;
      maxLines: number;
      path: string;
      startLine: number;
    }
  | {
      ok: false;
      message: string;
    };

function getOptionalLineNumber(input: ToolCallArgs, key: string) {
  const value = input[key];

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      ok: false,
      message: `"${key}" must be a whole number.`,
    } as const;
  }

  if (value < 1) {
    return {
      ok: false,
      message: `"${key}" must be greater than or equal to 1.`,
    } as const;
  }

  return {
    ok: true,
    value,
  } as const;
}

function parseReadFileInput(input: ToolExecutionInput): ParsedReadFileInput {
  if (typeof input === "string") {
    const path = input.trim();

    if (!path) {
      return {
        ok: false,
        message: "read_file needs a non-empty file path.",
      };
    }

    return {
      ok: true,
      maxLines: DEFAULT_MAX_LINES,
      path,
      startLine: 1,
    };
  }

  const path = typeof input.path === "string" ? input.path.trim() : "";

  if (!path) {
    return {
      ok: false,
      message: 'read_file needs a non-empty "path" value.',
    };
  }

  const startLine = getOptionalLineNumber(input, "start_line");
  if (startLine?.ok === false) {
    return startLine;
  }

  const maxLines = getOptionalLineNumber(input, "max_lines");
  if (maxLines?.ok === false) {
    return maxLines;
  }

  if (maxLines !== null && maxLines.value > MAX_LINES_LIMIT) {
    return {
      ok: false,
      message: `"max_lines" must be less than or equal to ${MAX_LINES_LIMIT}.`,
    };
  }

  return {
    ok: true,
    maxLines: maxLines?.value ?? DEFAULT_MAX_LINES,
    path,
    startLine: startLine?.value ?? 1,
  };
}

function splitFileLines(fileContent: string) {
  if (fileContent.length === 0) {
    return [];
  }

  const lines = fileContent.split(/\r?\n/);

  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function formatNumberedWindow(
  lines: string[],
  parsed: Extract<ParsedReadFileInput, { ok: true }>,
): ToolResult {
  if (lines.length === 0) {
    return {
      ok: true,
      content: `File: ${parsed.path}\nLines: 0 of 0\n\n(empty file)`,
    };
  }

  if (parsed.startLine > lines.length) {
    return {
      ok: false,
      content: `"start_line" is beyond the end of the file. ${parsed.path} has ${lines.length} line(s).`,
    };
  }

  const startIndex = parsed.startLine - 1;
  const endIndexExclusive = Math.min(startIndex + parsed.maxLines, lines.length);
  const lineNumberWidth = String(endIndexExclusive).length;
  const numberedLines = lines
    .slice(startIndex, endIndexExclusive)
    .map((line, index) => {
      const lineNumber = String(parsed.startLine + index).padStart(
        lineNumberWidth,
        " ",
      );

      return `${lineNumber} | ${line}`;
    });

  const shownEndLine = endIndexExclusive;
  const truncated = shownEndLine < lines.length;
  const header = [
    `File: ${parsed.path}`,
    `Lines: ${parsed.startLine}-${shownEndLine} of ${lines.length}`,
    truncated
      ? `Output truncated. Use start_line=${shownEndLine + 1} to continue.`
      : null,
  ].filter((line): line is string => line !== null);

  return {
    ok: true,
    content: `${header.join("\n")}\n\n${numberedLines.join("\n")}`,
  };
}

async function executeReadFile(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseReadFileInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    const targetPath = resolveWorkspacePath(parsed.path);
    const fileContent = await readFile(targetPath, "utf8");

    return formatNumberedWindow(splitFileLines(fileContent), parsed);
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
  description:
    "Read a UTF-8 text file from the configured workspace root with line numbers and optional line-window limits.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Required file path relative to the configured workspace root.",
      },
      start_line: {
        type: "number",
        description:
          "Optional 1-based line number to start reading from. Defaults to 1.",
      },
      max_lines: {
        type: "number",
        description: `Optional number of lines to read. Defaults to ${DEFAULT_MAX_LINES}; maximum ${MAX_LINES_LIMIT}.`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: executeReadFile,
};
