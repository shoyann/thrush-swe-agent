import { existsSync, statSync } from "node:fs";
import path from "node:path";

export function normalizeWorkspacePath(workspacePath: string) {
  const resolvedPath = path.resolve(workspacePath.trim());

  if (!path.isAbsolute(resolvedPath)) {
    throw new Error("Workspace path must be absolute.");
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Workspace path does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Workspace path is not a folder: ${resolvedPath}`);
  }

  const parsed = path.parse(resolvedPath);
  const normalized = path.normalize(resolvedPath);
  const blockedRoots = [
    parsed.root,
    path.resolve(parsed.root, "Windows"),
    path.resolve(parsed.root, "Program Files"),
    path.resolve(parsed.root, "Program Files (x86)"),
    path.resolve(parsed.root, "Users"),
  ].map((blockedPath) => path.normalize(blockedPath).toLowerCase());

  if (blockedRoots.includes(normalized.toLowerCase())) {
    throw new Error("Workspace path is too broad. Choose a specific project folder.");
  }

  return normalized;
}
