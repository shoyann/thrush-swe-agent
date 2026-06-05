import type {
  AgentSessionContext,
  AgentStep,
  ChatMessage,
} from "@/types/agent";

export type ProjectSummary = {
  createdAt: number;
  id: string;
  name: string;
  sessions: SessionSummary[];
  updatedAt: number;
  workspacePath: string;
  workspacePathConfirmedAt: number | null;
};

export type SessionSummary = {
  auto_approve: number;
  createdAt: number;
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
};

export type SessionDetail = SessionSummary & {
  messages: ChatMessage[];
  sessionContext: AgentSessionContext;
  steps: AgentStep[];
};

export type WorkbenchSnapshot = {
  activeSessionId: string | null;
  projects: ProjectSummary[];
};
