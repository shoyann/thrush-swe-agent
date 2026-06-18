import { readFileSync } from "node:fs";
import type { AutoFailureCategory, AutoMiniExitStatus } from "../../types/auto";

export function parseMiniExitStatus(trajectoryPath: string): AutoMiniExitStatus {
  try {
    const parsed = JSON.parse(readFileSync(trajectoryPath, "utf8")) as {
      info?: { exit_status?: unknown };
    };
    const status = parsed.info?.exit_status;

    if (
      status === "Submitted" ||
      status === "LimitsExceeded" ||
      status === "TimeExceeded" ||
      status === "RepeatedFormatError"
    ) {
      return status;
    }

    return typeof status === "string" && status.trim() ? "Error" : "Unknown";
  } catch {
    return "Unknown";
  }
}

export function getMiniFailure(input: {
  exitCode: number;
  logText: string;
  miniExitStatus: AutoMiniExitStatus;
}): { category: AutoFailureCategory; message: string } {
  if (input.miniExitStatus === "LimitsExceeded") {
    return {
      category: "cost_limit",
      message:
        "mini-swe-agent stopped because it reached its configured cost or step limit. Increase the Auto limits or ask for a smaller task.",
    };
  }

  if (input.miniExitStatus === "TimeExceeded") {
    return {
      category: "timeout",
      message:
        "mini-swe-agent ran out of time before it could submit a solution. Try a smaller task or increase the Auto time limit.",
    };
  }

  if (input.miniExitStatus === "RepeatedFormatError") {
    return {
      category: "repeated_format_error",
      message:
        "mini-swe-agent could not keep producing valid tool calls. Try restating the task more concretely or using a different model.",
    };
  }

  if (/docker|daemon|container|pull access denied|cannot connect/i.test(input.logText)) {
    return {
      category: "docker_start_failed",
      message:
        "Docker started the Auto Run but mini-swe-agent could not use the container successfully. Check Docker Desktop, image access, and the run logs.",
    };
  }

  if (
    /UV_HTTP_TIMEOUT|Failed to download|Failed to extract archive|network timeout|download distribution/i.test(
      input.logText,
    )
  ) {
    return {
      category: "dependency_install_failed",
      message:
        "Auto could not finish installing mini-swe-agent dependencies because a package download timed out. Check the network/proxy and retry; Thrush will use a longer dependency download timeout by default.",
    };
  }

  return {
    category: "mini_failed",
    message: `mini-swe-agent exited without submitting a completed result. Exit code: ${input.exitCode}. Review the logs for details.`,
  };
}
