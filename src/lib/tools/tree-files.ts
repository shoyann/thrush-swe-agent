import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentTool,
  ToolExecutionInput,
  ToolInputValue,
  ToolResult,
} from "@/lib/tools/types";
import { getWorkspaceRoot, resolveWorkspacePath } from "@/lib/tools/workspace-path";

const DEFAULT_MAX_DEPTH = 3;
const MAX_NODES = 200;
const DEFAULT_IGNORED_NAMES = ["node_modules", ".git", "dist", ".next"];

type TreeFileNode = {
  name: string;
  type: "file" | "dir";
  children: TreeFileNode[];
};

type ParsedTreeFilesInput = {
  ignore: string[];
  maxDepth: number;
  path: string;
};

function parseStringArray(value: ToolInputValue | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMaxDepth(value: ToolInputValue | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_DEPTH;
  }

  return Math.max(0, Math.floor(value));
}

function parseTreeFilesInput(input: ToolExecutionInput): ParsedTreeFilesInput {
  if (typeof input === "string") {
    return {
      ignore: DEFAULT_IGNORED_NAMES,
      maxDepth: DEFAULT_MAX_DEPTH,
      path: input.trim() || ".",
    };
  }

  const requestedPath =
    typeof input.path === "string" && input.path.trim()
      ? input.path.trim()
      : ".";
  const requestedIgnore = parseStringArray(input.ignore);

  return {
    ignore: requestedIgnore.length > 0 ? requestedIgnore : DEFAULT_IGNORED_NAMES,
    maxDepth: parseMaxDepth(input.max_depth),
    path: requestedPath,
  };
}

async function buildTree(
  targetPath: string,
  depth: number,
  options: {
    ignoredNames: Set<string>;
    maxDepth: number;
    relativePath: string;
    state: { count: number; truncated: boolean };
  },
): Promise<TreeFileNode | null> {
  if (options.state.count >= MAX_NODES) {
    options.state.truncated = true;
    return null;
  }

  options.state.count += 1;

  const stats = await lstat(targetPath);
  const node: TreeFileNode = {
    children: [],
    name: path.basename(targetPath) || ".",
    type: stats.isDirectory() ? "dir" : "file",
  };

  if (!stats.isDirectory() || depth >= options.maxDepth) {
    return node;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  const sortedEntries = entries
    .filter((entry) => !options.ignoredNames.has(entry.name))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });

  for (const entry of sortedEntries) {
    if (options.state.count >= MAX_NODES) {
      options.state.truncated = true;
      break;
    }

    if (entry.isDirectory()) {
      const childRelativePath = path.join(options.relativePath, entry.name);
      const childPath = resolveWorkspacePath(childRelativePath);
      const childNode = await buildTree(childPath, depth + 1, {
        ...options,
        relativePath: childRelativePath,
      });

      if (childNode) {
        node.children.push(childNode);
      }

      continue;
    }

    options.state.count += 1;
    node.children.push({
      children: [],
      name: entry.name,
      type: "file",
    });
  }

  return node;
}

async function executeTreeFiles(input: ToolExecutionInput): Promise<ToolResult> {
  try {
    const parsedInput = parseTreeFilesInput(input);
    const targetPath = resolveWorkspacePath(parsedInput.path);
    const relativePath = path.relative(getWorkspaceRoot(), targetPath) || ".";
    const state = {
      count: 0,
      truncated: false,
    };
    const rootNode = await buildTree(targetPath, 0, {
      ignoredNames: new Set(parsedInput.ignore),
      maxDepth: parsedInput.maxDepth,
      relativePath,
      state,
    });

    if (!rootNode) {
      return {
        ok: true,
        content: JSON.stringify(
          {
            message: `Tree scan stopped after reaching the ${MAX_NODES} node limit.`,
            root: null,
            truncated: true,
          },
          null,
          2,
        ),
      };
    }

    return {
      ok: true,
      content: JSON.stringify(
        {
          root: rootNode,
          truncated: state.truncated,
          ...(state.truncated
            ? {
                message: `Tree scan stopped after reaching the ${MAX_NODES} node limit.`,
              }
            : {}),
        },
        null,
        2,
      ),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The file tree could not be listed.";

    return {
      ok: false,
      content: message,
    };
  }
}

export const treeFilesTool: AgentTool = {
  name: "tree_files",
  description:
    "Return a JSON file tree inside the configured workspace root with depth, ignore, and node-count limits.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional path relative to the configured workspace root. Defaults to the workspace root itself.",
      },
      max_depth: {
        type: "number",
        description: "Optional maximum directory depth to scan. Defaults to 3.",
      },
      ignore: {
        type: "array",
        description:
          "Optional folder or file names to skip. Defaults to node_modules, .git, dist, and .next.",
        items: {
          type: "string",
        },
      },
    },
    additionalProperties: false,
  },
  execute: executeTreeFiles,
};
