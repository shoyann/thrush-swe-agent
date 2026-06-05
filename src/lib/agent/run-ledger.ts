import {
  classifySafeCommandIntent,
  extractRequiredValidations,
  getSafeCommandParts,
  isSameCommand,
  type CommandIntent,
  type RequiredValidation,
} from "./intent";
import type { ToolRun } from "./tool-run-types";

export type RunLedger = {
  appliedOrDraftedWrite: boolean;
  commandRuns: Array<{
    args: string[];
    command: string;
    intent: CommandIntent;
    ok: boolean;
    toolCallId: string;
  }>;
  readCount: number;
  requiredValidations: RequiredValidation[];
  toolRuns: ToolRun[];
  writePaths: string[];
};

export function createRunLedger(task: string, existingRequiredValidations: RequiredValidation[] = []): RunLedger {
  const extracted = extractRequiredValidations(task);
  const validations = existingRequiredValidations.length > 0 ? existingRequiredValidations : extracted;

  return {
    appliedOrDraftedWrite: false,
    commandRuns: [],
    readCount: 0,
    requiredValidations: validations.map((validation) => ({ ...validation })),
    toolRuns: [],
    writePaths: [],
  };
}

export function recordLedgerToolRun(
  ledger: RunLedger,
  task: string,
  toolRun: ToolRun,
) {
  ledger.toolRuns.push(toolRun);

  if (toolRun.name === "read_file" && toolRun.result.ok) {
    ledger.readCount += 1;
  }

  if ((toolRun.name === "write_file" || toolRun.name === "replace_text") && toolRun.result.draft) {
    ledger.appliedOrDraftedWrite = true;
    ledger.writePaths.push(toolRun.result.draft.path);
    for (const validation of ledger.requiredValidations) {
      validation.satisfiedAt = undefined;
      validation.satisfiedByToolCallId = undefined;
      validation.lastFailure = undefined;
    }
  }

  if (toolRun.name !== "safe_command") {
    return;
  }

  const command = getSafeCommandParts(toolRun.input);
  if (!command) {
    return;
  }

  const intent = classifySafeCommandIntent(toolRun.input, task, ledger.appliedOrDraftedWrite);
  ledger.commandRuns.push({
    ...command,
    intent,
    ok: toolRun.result.ok,
    toolCallId: toolRun.toolCallId,
  });

  for (const validation of ledger.requiredValidations) {
    if (!isSameCommand(command, validation)) {
      continue;
    }

    if (toolRun.result.ok) {
      validation.satisfiedAt = toolRun.finishedAt ?? Date.now();
      validation.satisfiedByToolCallId = toolRun.toolCallId;
      validation.lastFailure = undefined;
    } else {
      validation.lastFailure = toolRun.result.content;
    }
  }
}

export function getMissingRequiredValidations(ledger: RunLedger) {
  return ledger.requiredValidations.filter(
    (validation) => !validation.satisfiedByToolCallId,
  );
}

export function formatGroundingSummary(ledger: RunLedger) {
  const lines = ["Execution ledger:"];
  const uniqueWritePaths = [...new Set(ledger.writePaths)];

  lines.push(
    uniqueWritePaths.length > 0
      ? `- Drafted/applied file changes: ${uniqueWritePaths.join(", ")}`
      : "- Drafted/applied file changes: none",
  );

  if (ledger.commandRuns.length > 0) {
    lines.push("- Commands run:");
    for (const commandRun of ledger.commandRuns) {
      lines.push(
        `  - ${commandRun.command} ${commandRun.args.join(" ")}: ${commandRun.ok ? "passed" : "failed"} (${commandRun.intent})`,
      );
    }
  } else {
    lines.push("- Commands run: none");
  }

  if (ledger.requiredValidations.length > 0) {
    const missing = getMissingRequiredValidations(ledger);
    lines.push(
      missing.length === 0
        ? "- Required validations: all satisfied"
        : `- Required validations still missing or failed: ${missing.map((validation) => validation.label).join(", ")}`,
    );
  }

  return lines.join("\n");
}
