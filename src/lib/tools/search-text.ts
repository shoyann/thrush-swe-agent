import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { getWorkspaceRoot, resolveWorkspacePath } from "@/lib/tools/workspace-path";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 50;
const MAX_SNIPPET_LENGTH = 160;

function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseSearchTextObjectInput(input: ToolCallArgs) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const targetPath = typeof input.path === "string" ? input.path.trim() : ".";

  if (!query) {
    return {
      ok: false,
      message: 'search_text needs a non-empty "query" value.',
    } as const;
  }

  return {
    ok: true,
    query,
    targetPath: targetPath || ".",
  } as const;
}

function parseSearchTextStringInput(input: string) {
  const queryFromTag = parseTagBlock(input, "query");
  const pathFromTag = parseTagBlock(input, "path");

  if (queryFromTag !== null) {
    if (!queryFromTag) {
      return {
        ok: false,
        message: "search_text needs a non-empty <query>...</query> value.",
      } as const;
    }

    return {
      ok: true,
      query: queryFromTag,
      targetPath: pathFromTag || ".",
    } as const;
  }

  const query = input.trim();
  if (!query) {
    return {
      ok: false,
      message:
        "search_text needs a query. Use plain text, or <query>text</query><path>optional/folder</path>.",
    } as const;
  }

  return {
    ok: true,
    query,
    targetPath: ".",
  } as const;
}

function shortenSnippet(line: string) {
  const normalizedLine = line.replace(/\s+/g, " ").trim();

  if (normalizedLine.length <= MAX_SNIPPET_LENGTH) {
    return normalizedLine;
  }

  return `${normalizedLine.slice(0, MAX_SNIPPET_LENGTH - 3)}...`;
}

function formatMatches(
  output: string,
  query: string,
  targetPath: string,
) {
  const uniqueMatches = new Map<string, string>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const match = line.match(/^(.*?):(\d+):(\d+):(.*)$/);
    if (!match) {
      continue;
    }

    const [, filePath, lineNumber, , snippet] = match;
    const normalizedPath = filePath.replace(/\\/g, "/");
    const key = `${normalizedPath}:${lineNumber}`;

    if (!uniqueMatches.has(key)) {
      uniqueMatches.set(key, `${normalizedPath}:${lineNumber}: ${shortenSnippet(snippet)}`);
    }

    if (uniqueMatches.size >= MAX_RESULTS) {
      break;
    }
  }

  if (uniqueMatches.size === 0) {
    return `No matches found for "${query}" in ${targetPath}.`;
  }

  return [
    `Search results for "${query}" in ${targetPath}:`,
    ...uniqueMatches.values(),
  ].join("\n");
}

function parseSearchTextInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return parseSearchTextStringInput(input);
  }

  return parseSearchTextObjectInput(input);
}

async function executeSearchText(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseSearchTextInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    const absoluteTargetPath = resolveWorkspacePath(parsed.targetPath);
    const relativeTargetPath =
      path.relative(getWorkspaceRoot(), absoluteTargetPath).replace(/\\/g, "/") || ".";

    const { stdout } = await execFileAsync(
      "rg",
      [
        "--vimgrep",
        "--color",
        "never",
        "--smart-case",
        "--no-heading",
        "--no-messages",
        "--",
        parsed.query,
        relativeTargetPath,
      ],
      {
        cwd: getWorkspaceRoot(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );

    return {
      ok: true,
      content: formatMatches(stdout, parsed.query, relativeTargetPath),
    };
  } catch (error) {
    const result = error as {
      code?: number | string;
      message?: string;
      stdout?: string;
    };

    if (result.code === 1) {
      return {
        ok: true,
        content: `No matches found for "${parsed.query}" in ${parsed.targetPath}.`,
      };
    }

    return {
      ok: false,
      content:
        result.message ??
        "search_text failed. Make sure ripgrep (rg) is installed and the path is valid.",
    };
  }
}

export const searchTextTool: AgentTool = {
  name: "search_text",
  description:
    "Search text inside files under the configured workspace root with ripgrep. Input: plain query text, or <query>text</query><path>optional/folder-or-file</path>.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Required search text to pass to ripgrep.",
      },
      path: {
        type: "string",
        description:
          "Optional folder or file path relative to the configured workspace root.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: executeSearchText,
};
