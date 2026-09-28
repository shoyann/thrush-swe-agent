import type { AgentTool } from "./types";

/** These declarations are exposed to the model; only the workflow controller may apply them. */
export const taskPlanTool: AgentTool = {
  name: "task_plan",
  description:
    "Record the full task plan before acting. Later calls may add checks, never remove earlier requirements.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "change for implementation/fixes, inspect for investigation or running a command only.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description:
          "Concrete steps covering all user requirements, including regression tests when requested.",
      },
      checks: {
        type: "array",
        items: { type: "string" },
        description:
          "Exact safe_command command plus arguments joined with spaces, e.g. npm test. All must pass after the last edit.",
      },
      verification_note: {
        type: "string",
        description:
          "If checks are unavailable, explain why. Never skip requested tests merely to finish.",
      },
    },
    required: ["kind", "steps", "checks", "verification_note"],
    additionalProperties: false,
  },
  async execute() {
    return {
      ok: false,
      content: "task_plan must be handled by the workflow controller.",
    };
  },
};

export const finishTaskTool: AgentTool = {
  name: "finish_task",
  description:
    "Request task completion, or report blocked/needs_input. Completion is checked against real writes and verification results.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "completed, blocked, needs_input, or unverified. Use unverified only when files were changed but verification cannot be completed; explain the missing checks",
      },
      message: {
        type: "string",
        description:
          "User-facing result in the user's language: changes, actual checks, remaining limitations or precise question.",
      },
    },
    required: ["status", "message"],
    additionalProperties: false,
  },
  async execute() {
    return {
      ok: false,
      content: "finish_task must be handled by the workflow controller.",
    };
  },
};
