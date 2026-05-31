export type Role = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  reasoning_content?: string | null;
};

export type PendingDraftSnapshot = {
  content: string;
  id: string;
  kind: "write_file";
  path: string;
};

export type AgentSessionContext = {
  lastListedDirectoryPath?: string | null;
  lastReadFilePath?: string | null;
  lastToolInput?: string | null;
  lastToolName?: string | null;
  pendingDraft?: PendingDraftSnapshot | null;
};

export type StepStatus = "idle" | "running" | "done";

export type AgentStep = {
  id: string;
  title: string;
  detail: string;
  status: StepStatus;
};

export type AgentRequest = {
  messages?: ChatMessage[];
  sessionContext?: AgentSessionContext;
  stream?: boolean;
  task: string;
};

export type AgentResponse = {
  message: ChatMessage;
  sessionContext: AgentSessionContext;
  steps: AgentStep[];
};

export type AgentStreamEvent =
  | {
      type: "steps";
      steps: AgentStep[];
    }
  | {
      type: "message";
      message: ChatMessage;
    }
  | {
      type: "done";
      sessionContext: AgentSessionContext;
    };
