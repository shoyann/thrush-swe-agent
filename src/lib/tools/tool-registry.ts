import { clickPageTool } from "@/lib/tools/click-page";
import { gitInspectTool } from "@/lib/tools/git-inspect";
import { listFilesTool } from "@/lib/tools/list-files";
import { readFileTool } from "@/lib/tools/read-file";
import { readPageTool } from "@/lib/tools/read-page";
import { replaceTextTool } from "@/lib/tools/replace-text";
import { safeCommandTool } from "@/lib/tools/safe-command";
import { searchTextTool } from "@/lib/tools/search-text";
import { sweAgentTool } from "@/lib/tools/swe-agent";
import { treeFilesTool } from "@/lib/tools/tree-files";
import { webSearchTool } from "@/lib/tools/web-search";
import { writeFileTool } from "@/lib/tools/write-file";
import type { AgentTool } from "@/lib/tools/types";

const readOnlyBlockedToolNames = new Set(["write_file", "replace_text"]);

const tools: AgentTool[] = [
  clickPageTool,
  gitInspectTool,
  listFilesTool,
  readFileTool,
  readPageTool,
  replaceTextTool,
  safeCommandTool,
  searchTextTool,
  sweAgentTool,
  treeFilesTool,
  webSearchTool,
  writeFileTool,
];

export function isReadOnlyBlockedTool(toolName: string) {
  return readOnlyBlockedToolNames.has(toolName);
}

export function getTool(name: string) {
  return tools.find((tool) => tool.name === name);
}

export function listTools(options: { readOnly?: boolean } = {}) {
  return tools
    .filter((tool) =>
      options.readOnly ? !isReadOnlyBlockedTool(tool.name) : true,
    )
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
}
