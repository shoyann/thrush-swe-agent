import path from "node:path";
import type { AgentSessionContext, AgentStep } from "@/types/agent";
import { normalizeWorkspacePath } from "@/lib/workspace/validation";

const CONFIRM_WORKSPACE_SWITCH_COMMAND = "CONFIRM_WORKSPACE_SWITCH";
const CANCEL_WORKSPACE_SWITCH_COMMAND = "CANCEL_WORKSPACE_SWITCH";

type WorkspaceSwitchResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      message: string;
      sessionContext: AgentSessionContext;
      steps: AgentStep[];
    };

function buildWorkspaceSwitchSteps(detail: string): AgentStep[] {
  return [
    {
      id: "perceive",
      title: "Perceive",
      detail: "Detected a workspace switch request in the chat.",
      status: "done",
    },
    {
      id: "think",
      title: "Think",
      detail,
      status: "done",
    },
    {
      id: "act",
      title: "Act",
      detail: "Reply in chat and update only this session state when confirmed.",
      status: "done",
    },
  ];
}

function createSwitchId() {
  return "ws_" + Math.random().toString(36).slice(2, 10);
}

function isConfirmTask(task: string, expectedId?: string) {
  const cleanTask = task.trim();

  if (
    expectedId &&
    cleanTask.toUpperCase() ===
      `${CONFIRM_WORKSPACE_SWITCH_COMMAND} ${expectedId}`.toUpperCase()
  ) {
    return true;
  }

  return (
    /^(yes|y|ok)$/i.test(cleanTask) ||
    /^(\u786e\u8ba4|\u662f|\u53ef\u4ee5|\u597d|\u5207\u6362|\u5207\u5230\u8fd9\u4e2a\u9879\u76ee)$/.test(
      cleanTask,
    )
  );
}

function isCancelTask(task: string, expectedId?: string) {
  const cleanTask = task.trim();

  if (
    expectedId &&
    cleanTask.toUpperCase() ===
      `${CANCEL_WORKSPACE_SWITCH_COMMAND} ${expectedId}`.toUpperCase()
  ) {
    return true;
  }

  return (
    /^(no|n|cancel)$/i.test(cleanTask) ||
    /^(\u53d6\u6d88|\u4e0d\u8981|\u4e0d\u5207|\u7b97\u4e86)$/.test(cleanTask)
  );
}

function stripWrappingQuotes(rawPath: string) {
  return rawPath.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function cleanExtractedPath(rawPath: string) {
  let cleanPath = stripWrappingQuotes(rawPath.trim());

  cleanPath = cleanPath.replace(/[;,!?].*$/g, "").trim();

  const trailingPhrases = [
    "look",
    "inspect",
    "check",
    "\u770b\u770b",
    "\u770b\u4e00\u4e0b",
    "\u770b\u4e0b",
    "\u68c0\u67e5\u4e00\u4e0b",
    "\u68c0\u67e5\u4e0b",
    "\u8fd9\u4e2a\u9879\u76ee",
    "\u8fd9\u4e2a\u76ee\u5f55",
    "\u8fd9\u4e2a\u6587\u4ef6\u5939",
    "\u5207\u5230\u8fd9\u4e2a\u9879\u76ee",
    "\u5207\u8fc7\u53bb",
  ];

  let changed = true;
  while (changed) {
    changed = false;

    for (const phrase of trailingPhrases) {
      if (cleanPath.toLowerCase().endsWith(phrase.toLowerCase())) {
        cleanPath = cleanPath.slice(0, -phrase.length).trim();
        changed = true;
      }
    }
  }

  return stripWrappingQuotes(cleanPath);
}

export function extractWorkspaceSwitchPath(task: string) {
  const quotedPathMatch = task.match(/["']([^"']*[A-Za-z]:[\\/][^"']+)["']/);
  if (quotedPathMatch?.[1]) {
    return cleanExtractedPath(quotedPathMatch[1]);
  }

  const windowsPathMatch = task.match(/[A-Za-z]:[\\/][^\r\n]+/);
  if (windowsPathMatch?.[0]) {
    return cleanExtractedPath(windowsPathMatch[0]);
  }

  const unixPathMatch = task.match(/(?:^|\s)(\/[^\r\n]+)/);
  if (unixPathMatch?.[1]) {
    return cleanExtractedPath(unixPathMatch[1]);
  }

  return null;
}

export function getEffectiveWorkspacePath(
  sessionContext: AgentSessionContext,
  projectWorkspacePath: string,
) {
  return sessionContext.workspacePathOverride?.trim() || projectWorkspacePath;
}

export function handleWorkspaceSwitchTask(input: {
  projectId: string;
  projectWorkspacePath: string;
  sessionContext: AgentSessionContext;
  sessionId: string;
  task: string;
}): WorkspaceSwitchResult {
  const { projectId, projectWorkspacePath, sessionId, task } = input;
  const sessionContext: AgentSessionContext = {
    ...input.sessionContext,
    projectId,
    sessionId,
  };
  const pendingSwitch = sessionContext.pendingWorkspaceSwitch ?? null;

  if (pendingSwitch && isCancelTask(task, pendingSwitch.id)) {
    return {
      handled: true,
      message: [
        "Workspace switch cancelled.",
        "",
        `Current workspace: ${getEffectiveWorkspacePath(
          sessionContext,
          projectWorkspacePath,
        )}`,
      ].join("\n"),
      sessionContext: {
        ...sessionContext,
        pendingWorkspaceSwitch: null,
      },
      steps: buildWorkspaceSwitchSteps("The user cancelled the pending workspace switch."),
    };
  }

  if (pendingSwitch && isConfirmTask(task, pendingSwitch.id)) {
    if (sessionContext.pendingDraft) {
      return {
        handled: true,
        message: [
          "I cannot switch workspace yet because this session has a pending write draft.",
          "",
          `Draft path: ${sessionContext.pendingDraft.path}`,
          "",
          "Approve the draft with YES, or discard it with NO. Then confirm the workspace switch again.",
        ].join("\n"),
        sessionContext,
        steps: buildWorkspaceSwitchSteps(
          "Blocked workspace switch because a pending write draft still exists.",
        ),
      };
    }

    let workspacePath: string;

    try {
      workspacePath = normalizeWorkspacePath(pendingSwitch.workspacePath);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Workspace path validation failed.";

      return {
        handled: true,
        message: [
          "The pending workspace path is no longer valid, so I did not switch.",
          "",
          message,
          "",
          "Send a real local folder path again to retry.",
        ].join("\n"),
        sessionContext: {
          ...sessionContext,
          pendingWorkspaceSwitch: null,
        },
        steps: buildWorkspaceSwitchSteps("The pending workspace path failed validation."),
      };
    }

    return {
      handled: true,
      message: [
        "Switched this session to the new workspace.",
        "",
        `New workspace: ${workspacePath}`,
        "",
        "I also cleared the old file and directory hints for this session, so later tool calls stay tied to the new workspace.",
      ].join("\n"),
      sessionContext: {
        ...sessionContext,
        lastListedDirectoryPath: null,
        lastReadFilePath: null,
        lastToolInput: null,
        lastToolName: null,
        pendingWorkspaceSwitch: null,
        workspacePathOverride: workspacePath,
      },
      steps: buildWorkspaceSwitchSteps("The workspace switch was confirmed and applied."),
    };
  }

  const requestedPath = extractWorkspaceSwitchPath(task);
  if (!requestedPath) {
    return { handled: false };
  }

  let workspacePath: string;

  try {
    workspacePath = normalizeWorkspacePath(requestedPath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Workspace path validation failed.";

    return {
      handled: true,
      message: [
        "I did not switch workspace because the path failed validation.",
        "",
        message,
        "",
        "Send a specific local project folder that already exists.",
      ].join("\n"),
      sessionContext,
      steps: buildWorkspaceSwitchSteps("The requested workspace path failed validation."),
    };
  }

  if (sessionContext.pendingDraft) {
    return {
      handled: true,
      message: [
        "I cannot switch workspace because this session has a pending write draft.",
        "",
        `Draft path: ${sessionContext.pendingDraft.path}`,
        "",
        "Approve the draft with YES, or discard it with NO. Then send the workspace switch request again.",
      ].join("\n"),
      sessionContext,
      steps: buildWorkspaceSwitchSteps(
        "Blocked workspace switch before confirmation because a pending write draft exists.",
      ),
    };
  }

  const switchId = createSwitchId();
  const nextContext: AgentSessionContext = {
    ...sessionContext,
    pendingWorkspaceSwitch: {
      id: switchId,
      originalTask: task,
      requestedAt: Date.now(),
      workspacePath,
    },
  };

  return {
    handled: true,
    message: [
      "I can switch this session to that workspace, but need your confirmation first.",
      "",
      `Target workspace: ${workspacePath}`,
      `Current workspace: ${getEffectiveWorkspacePath(sessionContext, projectWorkspacePath)}`,
      "",
      "After confirmation:",
      "- Only this session changes; other sessions in the project stay unchanged.",
      "- Agent tools will be limited to the target workspace.",
      "- Old file and directory hints will be cleared to avoid mixing paths.",
      "",
      `To switch, reply: ${CONFIRM_WORKSPACE_SWITCH_COMMAND} ${switchId}`,
      `To cancel, reply: ${CANCEL_WORKSPACE_SWITCH_COMMAND} ${switchId}`,
      "",
      "You can also reply with yes/confirm or no/cancel.",
    ].join("\n"),
    sessionContext: nextContext,
    steps: buildWorkspaceSwitchSteps(
      `Validated target folder ${path.basename(workspacePath) || workspacePath} and requested confirmation.`,
    ),
  };
}
