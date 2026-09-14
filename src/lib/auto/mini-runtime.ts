import { runtimePaths } from "../runtime/paths";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type MiniRuntimeStatus =
  | {
      message: string;
      pythonPath: string;
      ready: true;
    }
  | {
      message: string;
      pythonPath: string | null;
      ready: false;
      reason: "missing" | "stale" | "broken";
    };

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function getMiniRuntimePaths(root = process.cwd()) {
  const paths = runtimePaths(root);
  const venvDir = path.join(paths.runtime, "mini-venv");

  return {
    readyPath: path.join(venvDir, ".ready.json"),
    requirementsPath: path.join(
      paths.resources,
      "scripts",
      "mini-runtime-requirements.txt",
    ),
    vendorDir: path.join(paths.resources, "vendor", "mini-swe-agent"),
    wrapperPath: path.join(paths.resources, "scripts", "mini-auto-run.py"),
    windowsMini: path.join(venvDir, "Scripts", "mini.exe"),
    windowsPython: path.join(venvDir, "Scripts", "python.exe"),
    posixMini: path.join(venvDir, "bin", "mini"),
    posixPython: path.join(venvDir, "bin", "python"),
  };
}

export function getPreferredMiniPython(root = process.cwd()) {
  const paths = getMiniRuntimePaths(root);

  if (process.platform === "win32" && existsSync(paths.windowsPython)) {
    return paths.windowsPython;
  }

  if (existsSync(paths.posixPython)) {
    return paths.posixPython;
  }

  return process.platform === "win32" ? paths.windowsPython : paths.posixPython;
}

function canImportRuntime(pythonPath: string) {
  try {
    execFileSync(pythonPath, ["-c", "import litellm, openai, minisweagent"], {
      stdio: "ignore",
      timeout: 15_000,
      windowsHide: true,
    });

    return true;
  } catch {
    return false;
  }
}

function readRequirementsHash(requirementsPath: string) {
  try {
    return sha256(readFileSync(requirementsPath, "utf8"));
  } catch {
    return null;
  }
}

function readReadyHash(readyPath: string) {
  try {
    const parsed = JSON.parse(readFileSync(readyPath, "utf8")) as {
      requirementsSha256?: unknown;
    };

    return typeof parsed.requirementsSha256 === "string"
      ? parsed.requirementsSha256
      : null;
  } catch {
    return null;
  }
}

export function getMiniRuntimeStatus(root = process.cwd()): MiniRuntimeStatus {
  const paths = getMiniRuntimePaths(root);
  const pythonPath = getPreferredMiniPython(root);

  if (!existsSync(paths.vendorDir) || !existsSync(paths.wrapperPath)) {
    return {
      message:
        process.env.THRUSH_DESKTOP === "1"
          ? "The bundled Agent is missing. Reinstall Thrush."
          : "Bundled mini-swe-agent source is missing. Run git submodule update --init --recursive.",
      pythonPath: null,
      ready: false,
      reason: "missing",
    };
  }

  if (!existsSync(pythonPath)) {
    return {
      message:
        process.env.THRUSH_DESKTOP === "1"
          ? "Prepare the Agent in Settings → Runtime & tools before starting Auto."
          : "Auto runtime is not prepared yet. Run npm run bootstrap:mini once before starting Auto.",
      pythonPath,
      ready: false,
      reason: "missing",
    };
  }

  const requirementsHash = readRequirementsHash(paths.requirementsPath);
  const readyHash = readReadyHash(paths.readyPath);

  if (!requirementsHash || !readyHash || requirementsHash !== readyHash) {
    return {
      message:
        process.env.THRUSH_DESKTOP === "1"
          ? "The Agent runtime needs an update. Choose Prepare Agent & browser in Settings."
          : "Auto runtime is out of date. Run npm run bootstrap:mini to refresh mini-swe-agent dependencies.",
      pythonPath,
      ready: false,
      reason: "stale",
    };
  }

  if (!canImportRuntime(pythonPath)) {
    return {
      message:
        process.env.THRUSH_DESKTOP === "1"
          ? "The Agent runtime could not start. Retry preparation in Settings → Runtime & tools."
          : "Auto runtime exists but cannot import mini-swe-agent/openai/litellm. Run npm run bootstrap:mini again.",
      pythonPath,
      ready: false,
      reason: "broken",
    };
  }

  return {
    message: "Auto runtime is ready.",
    pythonPath,
    ready: true,
  };
}
