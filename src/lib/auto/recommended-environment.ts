import { existsSync } from "node:fs";
import path from "node:path";
import type {
  MiniPresetConfig,
  RecommendedEnvironment,
} from "@/types/auto";

function hasFile(workspacePath: string, filename: string) {
  return existsSync(path.join(workspacePath, filename));
}

export function detectRecommendedEnvironment(
  workspacePath: string,
): RecommendedEnvironment {
  if (hasFile(workspacePath, "package.json")) {
    return {
      dockerImage: "node:22-bookworm",
      kind: "node",
      reason: "Detected package.json, so Thrush will use a Node.js environment.",
    };
  }

  if (
    hasFile(workspacePath, "pyproject.toml") ||
    hasFile(workspacePath, "requirements.txt")
  ) {
    return {
      dockerImage: "python:3.12-bookworm",
      kind: "python",
      reason:
        "Detected Python project files, so Thrush will use a Python environment.",
    };
  }

  if (hasFile(workspacePath, "Cargo.toml")) {
    return {
      dockerImage: "rust:bookworm",
      kind: "rust",
      reason: "Detected Cargo.toml, so Thrush will use a Rust environment.",
    };
  }

  return {
    dockerImage: "debian:bookworm",
    kind: "generic",
    reason:
      "No common project manifest was detected, so Thrush will use a generic Linux environment.",
  };
}

export function createRecommendedMiniPresetSnapshot(
  workspacePath: string,
): MiniPresetConfig {
  const environment = detectRecommendedEnvironment(workspacePath);
  const provider = process.env.MODEL_PROVIDER?.trim().toLowerCase();
  const modelName =
    provider === "openai"
      ? process.env.OPENAI_MODEL ?? "gpt-4.1-mini"
      : provider === "anthropic"
        ? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514"
        : process.env.DEEPSEEK_MINI_MODEL ??
          process.env.DEEPSEEK_MODEL ??
          "deepseek/deepseek-chat";

  return {
    costLimit: Number(process.env.AUTO_RUN_COST_LIMIT ?? 3),
    dockerImage: environment.dockerImage,
    environment: "docker",
    environmentKind: environment.kind,
    modelName,
    networkPolicy: "default",
    stepLimit: Number(process.env.AUTO_RUN_STEP_LIMIT ?? 0),
    wallTimeLimitSeconds: Number(
      process.env.AUTO_RUN_WALL_TIME_LIMIT_SECONDS ?? 3600,
    ),
  };
}
