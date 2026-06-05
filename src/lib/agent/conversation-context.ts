import type { AgentSessionContext, ChatMessage } from "@/types/agent";
import { callModelForText } from "@/lib/agent/model-client";

export const MAX_CONTEXT_MESSAGES = 8;

const MAX_CONVERSATION_SUMMARY_CHARS = 1600;

function normalizeConversationMessages(messages: ChatMessage[] | undefined, task: string) {
  if (!messages?.length) {
    return [];
  }

  const normalizedMessages = messages
    .filter((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        return false;
      }

      return message.content.trim().length > 0;
    })
    .map((message) => ({
      ...message,
      content: message.content.trim(),
    }));

  if (normalizedMessages.length === 0) {
    return [];
  }

  const lastMessage = normalizedMessages.at(-1);
  return lastMessage?.role === "user" && lastMessage.content === task.trim()
    ? normalizedMessages.slice(0, -1)
    : normalizedMessages;
}

export function normalizeSessionContext(
  sessionContext: AgentSessionContext | undefined,
): AgentSessionContext {
  if (!sessionContext) {
    return {};
  }

  return {
    autoApprove: sessionContext.autoApprove === true,
    conversationSummary: sessionContext.conversationSummary?.trim() || null,
    lastListedDirectoryPath: sessionContext.lastListedDirectoryPath?.trim() || null,
    lastReadFilePath: sessionContext.lastReadFilePath?.trim() || null,
    lastToolInput: sessionContext.lastToolInput?.trim() || null,
    lastToolName: sessionContext.lastToolName?.trim() || null,
    projectId: sessionContext.projectId?.trim() || null,
    readOnly: sessionContext.readOnly === true,
    sessionId: sessionContext.sessionId?.trim() || null,
    workspacePathOverride: sessionContext.workspacePathOverride?.trim() || null,
    pendingDraft: sessionContext.pendingDraft
      ? {
          ...sessionContext.pendingDraft,
          content: sessionContext.pendingDraft.content,
          id: sessionContext.pendingDraft.id.trim(),
          path: sessionContext.pendingDraft.path.trim(),
        }
      : null,
    pendingWorkspaceSwitch: sessionContext.pendingWorkspaceSwitch
      ? {
          ...sessionContext.pendingWorkspaceSwitch,
          id: sessionContext.pendingWorkspaceSwitch.id.trim(),
          originalTask: sessionContext.pendingWorkspaceSwitch.originalTask.trim(),
          readOnly: sessionContext.pendingWorkspaceSwitch.readOnly === true,
          workspacePath:
            sessionContext.pendingWorkspaceSwitch.workspacePath.trim(),
        }
      : null,
  };
}

export function formatConversationForModel(messages: ChatMessage[]) {
  if (messages.length === 0) {
    return "No recent conversation.";
  }

  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

export function formatConversationSummaryForModel(sessionContext: AgentSessionContext) {
  return sessionContext.conversationSummary?.trim() || "No older conversation summary.";
}

function trimConversationSummary(summary: string) {
  const cleanSummary = summary.trim();

  if (cleanSummary.length <= MAX_CONVERSATION_SUMMARY_CHARS) {
    return cleanSummary;
  }

  return cleanSummary.slice(0, MAX_CONVERSATION_SUMMARY_CHARS).trim();
}

async function summarizeOldConversation(
  model: string,
  existingSummary: string | null | undefined,
  oldConversation: ChatMessage[],
) {
  if (oldConversation.length === 0) {
    return existingSummary?.trim() || null;
  }

  const response = await callModelForText(model, [
    {
      role: "system",
      content: [
        "You compress old chat history for a coding agent.",
        "Write a short working-memory summary, not a transcript.",
        "Keep durable user requests, project facts, file paths, decisions, pending constraints, and unresolved tasks.",
        "Drop greetings, repeated content, and details that are already superseded.",
        "If the existing summary overlaps with the old messages, merge and deduplicate it.",
        `Stay under ${MAX_CONVERSATION_SUMMARY_CHARS} characters.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Existing summary:",
        existingSummary?.trim() || "(none)",
        "",
        "Old messages to fold into the summary:",
        formatConversationForModel(oldConversation),
      ].join("\n"),
    },
  ]);

  return trimConversationSummary(response.content) || null;
}

export async function prepareConversationContext(
  model: string,
  messages: ChatMessage[] | undefined,
  task: string,
  sessionContext: AgentSessionContext,
) {
  const conversation = normalizeConversationMessages(messages, task);
  const recentConversation = conversation.slice(-MAX_CONTEXT_MESSAGES);
  const oldConversation = conversation.slice(0, -MAX_CONTEXT_MESSAGES);

  if (oldConversation.length === 0) {
    return {
      recentConversation,
      sessionContext,
    };
  }

  const conversationSummary = await summarizeOldConversation(
    model,
    sessionContext.conversationSummary,
    oldConversation,
  );

  return {
    recentConversation,
    sessionContext: {
      ...sessionContext,
      conversationSummary,
    },
  };
}
