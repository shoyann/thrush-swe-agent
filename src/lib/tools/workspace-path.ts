import { existsSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_WORKSPACE_ROOT = path.resolve(process.cwd(), "data", "workspace");

function resolveConfiguredWorkspaceRoot() {
  const configuredRoot = process.env.AGENT_WORKSPACE_ROOT?.trim();

  if (!configuredRoot) {
    return DEFAULT_WORKSPACE_ROOT;
  }

  return path.resolve(configuredRoot);
}

function validateWorkspaceRoot(workspaceRoot: string) {
  if (!existsSync(workspaceRoot)) {
    throw new Error(
      [
        `Workspace root does not exist: ${workspaceRoot}`,
        "Set AGENT_WORKSPACE_ROOT to a real project folder, or leave it empty to use the default demo workspace.",
      ].join("\n"),
    );
  }

  if (!statSync(workspaceRoot).isDirectory()) {
    throw new Error(
      [
        `Workspace root is not a folder: ${workspaceRoot}`,
        "Set AGENT_WORKSPACE_ROOT to a real project folder, not a single file.",
      ].join("\n"),
    );
  }
}

export function getWorkspaceRoot() {
  const workspaceRoot = resolveConfiguredWorkspaceRoot();
  validateWorkspaceRoot(workspaceRoot);
  return workspaceRoot;
}

export function resolveWorkspacePath(input = ".") {
  const workspaceRoot = getWorkspaceRoot();
  const cleanInput = input.trim() || ".";
  const targetPath = path.resolve(workspaceRoot, cleanInput);
  const relativePath = path.relative(workspaceRoot, targetPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("The requested path is outside the configured workspace.");
  }

  return targetPath;
}
