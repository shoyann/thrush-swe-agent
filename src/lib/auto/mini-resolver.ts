import { existsSync } from "node:fs";
import {
  getMiniRuntimePaths,
  getMiniRuntimeStatus,
} from "./mini-runtime";

export type MiniCommand = {
  argsPrefix: string[];
  command: string;
  env?: Record<string, string>;
  source: "bundled" | "system" | "uvx";
};

function getEnvArgsPrefix() {
  const rawPrefix = process.env.AUTO_RUN_MINI_ARGS_PREFIX_JSON?.trim();
  if (!rawPrefix) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawPrefix) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function getBundledMiniCommand(root = process.cwd()): MiniCommand | null {
  const runtime = getMiniRuntimeStatus(root);
  const paths = getMiniRuntimePaths(root);

  if (runtime.ready) {
    return {
      argsPrefix: [paths.wrapperPath],
      command: runtime.pythonPath,
      source: "bundled",
    };
  }

  if (process.platform === "win32" && existsSync(paths.windowsMini)) {
    return {
      argsPrefix: ["-y"],
      command: paths.windowsMini,
      source: "bundled",
    };
  }

  if (existsSync(paths.posixMini)) {
    return {
      argsPrefix: ["-y"],
      command: paths.posixMini,
      source: "bundled",
    };
  }

  return null;
}

export function resolveMiniCommand(): MiniCommand {
  const bundled = getBundledMiniCommand();

  if (bundled) {
    return bundled;
  }

  if (process.env.AUTO_RUN_MINI_COMMAND?.trim()) {
    return {
      argsPrefix: getEnvArgsPrefix(),
      command: process.env.AUTO_RUN_MINI_COMMAND.trim(),
      source: "system",
    };
  }

  return {
    argsPrefix: ["mini-swe-agent"],
    command: "uvx",
    source: "uvx",
  };
}
