import type {
  AgentResponse,
  AgentSessionContext,
} from "@/types/agent";
import {
  formatConversationForModel,
  formatConversationSummaryForModel,
} from "@/lib/agent/conversation-context";
import type { AgentContext } from "@/lib/agent/agent-thinking";
import { callModelForText } from "@/lib/agent/model-client";
import { formatSessionContextForModel } from "@/lib/agent/session-state";
import type { SubtaskRecord } from "@/lib/db/store";

export type TaskDecompositionJudgment = {
  reason: string;
  split: boolean;
};

function parseJsonObject(content: string) {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function shouldDecomposeTask(
  goal: string,
  context: AgentContext,
): Promise<TaskDecompositionJudgment> {
  const response = await callModelForText(context.model, [
    {
      role: "system",
      content: [
        "You are a task decomposition judge for a coding agent.",
        "Decide whether the user's current task should be split into independent subtasks before execution.",
        "Return only valid JSON with this exact shape: {\"split\": boolean, \"reason\": string}.",
        "Use split=true for broad multi-file implementation work, multi-step refactors, or tasks that naturally have separate investigation, implementation, and validation phases.",
        "Use split=false for simple questions, single direct edits, draft approval/cancel flows, workspace switching, and tasks that one normal agent loop can handle directly.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Older conversation summary:",
        formatConversationSummaryForModel(context.sessionContext),
        "",
        "Recent conversation:",
        formatConversationForModel(context.recentConversation),
        "",
        "Session reference hints:",
        formatSessionContextForModel(context.sessionContext),
        "",
        `Current task: ${goal}`,
      ].join("\n"),
    },
  ]);

  const parsed = parseJsonObject(response.content);

  return {
    split: parsed?.split === true,
    reason:
      typeof parsed?.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : "The decomposition judge did not include a reason.",
  };
}

export async function planTask(goal: string, context: AgentContext) {
  const response = await callModelForText(context.model, [
    {
      role: "system",
      content: [
        "You break a coding-agent task into a short ordered subtask list.",
        "Return only valid JSON with this exact shape: {\"subtasks\": string[]}.",
        "Each subtask must be independently runnable by the same agent.",
        "Keep subtasks concrete and outcome-focused.",
        "Do not include a subtask that only says to report back.",
        "Prefer 2 to 5 subtasks.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Older conversation summary:",
        formatConversationSummaryForModel(context.sessionContext),
        "",
        "Recent conversation:",
        formatConversationForModel(context.recentConversation),
        "",
        "Session reference hints:",
        formatSessionContextForModel(context.sessionContext),
        "",
        `Task to split: ${goal}`,
      ].join("\n"),
    },
  ]);

  const parsed = parseJsonObject(response.content);
  const subtasks = parseStringArray(parsed?.subtasks);

  return subtasks.length > 0 ? subtasks : [goal];
}

export async function runSubtask(
  subtask: SubtaskRecord,
  sessionContext: AgentSessionContext,
): Promise<AgentResponse> {
  const { runAgent } = await import("@/lib/agent/run-agent");
  const task = [
    `Parent task: ${subtask.parentTask}`,
    `Current subtask: ${subtask.description}`,
    "",
    "Complete only the current subtask. Use the existing automatic loop. Do not re-plan the parent task.",
  ].join("\n");

  return runAgent(task, [], sessionContext, `subtask_${subtask.id}`, {
    disableTaskPlanning: true,
    projectId: sessionContext.projectId ?? undefined,
    sessionId: sessionContext.sessionId ?? undefined,
  });
}
