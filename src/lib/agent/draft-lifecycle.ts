import type { AgentResponse } from "@/types/agent";
import {
  applyPendingWriteDraft,
  clearPendingWriteDraft,
  getPendingWriteDraft,
} from "@/lib/tools/pending-write";
import {
  createMessage,
  createStep,
} from "@/lib/agent/agent-response";
import {
  APPROVE_WRITE_COMMAND,
  CANCEL_WRITE_COMMAND,
} from "@/lib/agent/tool-run-types";

type WriteCommand =
  | {
      type: "approve" | "cancel";
      draftId: string | null;
    }
  | null;

export type DraftLifecycleAction = "approve" | "cancel" | "continue";

export function parseWriteCommand(task: string): WriteCommand {
  const trimmedTask = task.trim();
  const approveMatch = trimmedTask.match(/^APPROVE_WRITE(?:\s+(\S+))?$/i);
  if (approveMatch) {
    return {
      type: "approve",
      draftId: approveMatch[1] ?? null,
    };
  }

  const cancelMatch = trimmedTask.match(/^CANCEL_WRITE(?:\s+(\S+))?$/i);
  if (cancelMatch) {
    return {
      type: "cancel",
      draftId: cancelMatch[1] ?? null,
    };
  }

  return null;
}

export function parseDraftLifecycleAction(
  task: string,
): DraftLifecycleAction | null {
  const trimmedTask = task.trim();

  if (!trimmedTask) {
    return null;
  }

  if (
    /^(?:please\s+)?approve(?:\s|$)/i.test(trimmedTask) ||
    /^(批准|确认写入|批准这个|批准刚才那个|确认这个draft|确认这个草稿|应用草稿|写入草稿)/u.test(
      trimmedTask,
    )
  ) {
    return "approve";
  }

  if (
    /^(?:please\s+)?cancel(?:\s|$)/i.test(trimmedTask) ||
    /^(取消|丢弃|丢掉|放弃|不要写了|取消这个|取消刚才那个)/u.test(
      trimmedTask,
    )
  ) {
    return "cancel";
  }

  if (
    /^(?:please\s+)?continue(?:\s|$)/i.test(trimmedTask) ||
    /^(继续|接着|继续上一步|继续刚才那个)/u.test(trimmedTask)
  ) {
    return "continue";
  }

  return null;
}

export function isAmbiguousDraftConfirmation(task: string) {
  const trimmedTask = task.trim().toLowerCase();

  return (
    /^(ok|okay|yes|yep|go ahead|looks good|approved?)$/.test(trimmedTask) ||
    /^(通过|好|行|可以|确认|没问题)$/.test(task.trim())
  );
}

export async function handleWriteApproval(
  task: string,
): Promise<AgentResponse | null> {
  const command = parseWriteCommand(task);

  if (!command) {
    return null;
  }

  if (!command.draftId) {
    const commandName =
      command.type === "approve" ? APPROVE_WRITE_COMMAND : CANCEL_WRITE_COMMAND;

    return {
      message: createMessage(
        [
          "A draft id is required.",
          `Use the exact format: ${commandName} draft-123`,
        ].join("\n"),
      ),
      sessionContext: {},
      steps: [
        createStep(
          "perceive",
          "Perceive",
          "Read a write confirmation command from the user.",
        ),
        createStep(
          "think",
          "Think",
          "Check whether the command includes a draft id.",
        ),
        createStep(
          "act",
          "Act",
          "Stop here because the command was missing its draft id.",
        ),
      ],
    };
  }

  if (command.type === "approve") {
    const pendingDraft = getPendingWriteDraft();

    if (!pendingDraft) {
      return {
        message: createMessage("There is no pending write draft to approve."),
        sessionContext: {},
        steps: [
          createStep(
            "perceive",
            "Perceive",
            "Read the approval command from the user.",
          ),
          createStep(
            "think",
            "Think",
            "Check whether a pending write draft exists.",
          ),
          createStep(
            "act",
            "Act",
            "No draft was waiting, so nothing was written.",
          ),
        ],
      };
    }

    if (pendingDraft.id !== command.draftId) {
      return {
        message: createMessage(
          [
            "The draft id did not match the current pending draft.",
            `Requested id: ${command.draftId}`,
            `Current pending id: ${pendingDraft.id}`,
          ].join("\n"),
        ),
        sessionContext: {
          pendingDraft,
        },
        steps: [
          createStep(
            "perceive",
            "Perceive",
            `Read the approval command for draft "${command.draftId}".`,
          ),
          createStep(
            "think",
            "Think",
            `Compare the requested id with the current pending draft id "${pendingDraft.id}".`,
          ),
          createStep(
            "act",
            "Act",
            "Refuse the write because the draft id did not match.",
          ),
        ],
      };
    }

    const appliedDraft = await applyPendingWriteDraft();

    return {
      message: createMessage(
        [
          "Write approved and saved.",
          `Draft id: ${pendingDraft.id}`,
          `Target path: ${pendingDraft.path}`,
          "The draft has been written to disk.",
        ].join("\n"),
      ),
      sessionContext: {
        lastToolInput: pendingDraft.path,
        lastToolName: "write_file",
        pendingDraft: null,
      },
      steps: [
        createStep(
          "perceive",
          "Perceive",
          `Read the exact approval command "${APPROVE_WRITE_COMMAND} ${pendingDraft.id}".`,
        ),
        createStep(
          "think",
          "Think",
          `Confirm that draft "${pendingDraft.id}" exists for "${pendingDraft.path}".`,
        ),
        createStep(
          "act",
          "Act",
          `Write approved draft "${appliedDraft?.id ?? pendingDraft.id}" to "${appliedDraft?.path ?? pendingDraft.path}".`,
        ),
      ],
    };
  }

  const pendingDraft = getPendingWriteDraft();

  if (!pendingDraft) {
    return {
      message: createMessage("There is no pending write draft to discard."),
      sessionContext: {},
      steps: [
        createStep(
          "perceive",
          "Perceive",
          "Read the cancel command from the user.",
        ),
        createStep(
          "think",
          "Think",
          "Check whether there is a pending draft to discard.",
        ),
        createStep(
          "act",
          "Act",
          "Nothing was waiting, so nothing was cleared.",
        ),
      ],
    };
  }

  if (pendingDraft.id !== command.draftId) {
    return {
      message: createMessage(
        [
          "The draft id did not match the current pending draft.",
          `Requested id: ${command.draftId}`,
          `Current pending id: ${pendingDraft.id}`,
        ].join("\n"),
      ),
      sessionContext: {
        pendingDraft,
      },
      steps: [
        createStep(
          "perceive",
          "Perceive",
          `Read the cancel command for draft "${command.draftId}".`,
        ),
        createStep(
          "think",
          "Think",
          `Compare the requested id with the current pending draft id "${pendingDraft.id}".`,
        ),
        createStep(
          "act",
          "Act",
          "Keep the draft because the cancel id did not match.",
        ),
      ],
    };
  }

  clearPendingWriteDraft();

  return {
    message: createMessage(
      [
        "Draft discarded.",
        `Draft id: ${pendingDraft.id}`,
        `Target path: ${pendingDraft.path}`,
      ].join("\n"),
    ),
    sessionContext: {
      lastToolInput: pendingDraft.path,
      lastToolName: "write_file",
      pendingDraft: null,
    },
    steps: [
      createStep(
        "perceive",
        "Perceive",
        `Read the exact cancel command "${CANCEL_WRITE_COMMAND} ${pendingDraft.id}".`,
      ),
      createStep(
        "think",
        "Think",
        `Confirm that draft "${pendingDraft.id}" is the one waiting to be discarded.`,
      ),
      createStep(
        "act",
        "Act",
        `Clear draft "${pendingDraft.id}" for "${pendingDraft.path}" without writing it.`,
      ),
    ],
  };
}
