import { getConfiguredModelName, callModelForText } from "@/lib/agent/model-client";
import type { AutoFailureCategory, AutoRun } from "@/types/auto";

export type AutoReportInput = {
  changedFiles: string;
  diffStat: string;
  failureCategory?: AutoFailureCategory | null;
  failureMessage?: string | null;
  logsTail: string;
  run: AutoRun;
  status: "canceled" | "completed" | "failed";
};

function fallbackResultLine(input: AutoReportInput) {
  if (input.status === "completed") {
    return "Completed. Thrush prepared changes in an isolated copy of the project.";
  }

  if (input.status === "canceled") {
    return "Canceled. The Auto Run was stopped before it finished.";
  }

  return `Failed. ${input.failureMessage ?? "The Auto Run did not finish successfully."}`;
}

export function createFallbackAutoReport(input: AutoReportInput) {
  return [
    "# Auto Report",
    "",
    "## Result",
    fallbackResultLine(input),
    "",
    "## What changed",
    input.changedFiles.trim() || "No changed files were recorded.",
    "",
    "## Why it changed",
    "mini-swe-agent attempted the requested task in an isolated worktree.",
    "",
    "## How it was verified",
    input.diffStat.trim() || "No verification summary was recorded.",
    "",
    "## What needs review",
    "Review the diff and logs before applying these changes or creating a Draft PR.",
    "",
    "## Risks or unfinished work",
    input.failureMessage ??
      "No additional risk note was recorded. The report is a summary; use the artifacts as the source of truth.",
    "",
    "## Artifacts",
    "- Diff",
    "- Diff stat",
    "- Changed files",
    "- Logs",
    "- mini-swe-agent trajectory when available",
  ].join("\n");
}

export async function generateAutoReport(input: AutoReportInput) {
  const fallback = createFallbackAutoReport(input);

  try {
    const response = await callModelForText(getConfiguredModelName(), [
      {
        role: "system",
        content:
          "You write concise, plain-language Auto Run reports for a local coding agent workbench. Do not exaggerate. If verification is missing or failed, say so clearly.",
      },
      {
        role: "user",
        content: [
          "Create an Auto Report with these exact headings:",
          "Result, What changed, Why it changed, How it was verified, What needs review, Risks or unfinished work, Artifacts.",
          "",
          `Task: ${input.run.task}`,
          `Status: ${input.status}`,
          `Failure: ${input.failureMessage ?? "(none)"}`,
          "",
          "Changed files:",
          input.changedFiles || "(none)",
          "",
          "Diff stat:",
          input.diffStat || "(none)",
          "",
          "Log tail:",
          input.logsTail || "(none)",
        ].join("\n"),
      },
    ]);

    return response.content.trim() || fallback;
  } catch {
    return fallback;
  }
}
