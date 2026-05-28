export type WriteFileDraft = {
  id: string;
  kind: "write_file";
  path: string;
  content: string;
};

export type ToolResult = {
  ok: boolean;
  content: string;
  draft?: WriteFileDraft;
};

export type ToolInputValue =
  | string
  | number
  | boolean
  | null
  | ToolInputValue[]
  | { [key: string]: ToolInputValue | undefined };

export type ToolCallArgs = Record<string, ToolInputValue | undefined>;

export type ToolInputProperty =
  | {
      type: "string";
      description: string;
    }
  | {
      type: "number";
      description: string;
    }
  | {
      type: "array";
      description: string;
      items: {
        type: "string";
      };
    };

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, ToolInputProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolExecutionInput = string | ToolCallArgs;

export type AgentTool = {
  description: string;
  inputSchema: ToolInputSchema;
  execute: (input: ToolExecutionInput) => Promise<ToolResult>;
  name: string;
};
