type WriteCommand = {
  type: "approve" | "cancel";
  draftId: string | null;
} | null;

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
    /^(取消|丢弃|丢掉|放弃|不要写了|取消这个|取消刚才那个)/u.test(trimmedTask)
  ) {
    return "cancel";
  }

  if (
    /^(?:please\s+)?continue(?:\s|$)/i.test(trimmedTask) ||
    /^(请)?(继续|接着|继续上一步|继续刚才那个)/u.test(trimmedTask)
  ) {
    return "continue";
  }

  return null;
}
