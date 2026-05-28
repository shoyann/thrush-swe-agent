import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteFileDraft } from "@/lib/tools/types";
import { resolveWorkspacePath } from "@/lib/tools/workspace-path";

let pendingDraft: WriteFileDraft | null = null;

export function savePendingWriteDraft(draft: WriteFileDraft) {
  pendingDraft = draft;
}

export function getPendingWriteDraft() {
  return pendingDraft;
}

export function clearPendingWriteDraft() {
  pendingDraft = null;
}

export async function applyPendingWriteDraft() {
  if (!pendingDraft) {
    return null;
  }

  const draft = pendingDraft;
  const targetPath = resolveWorkspacePath(draft.path);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, draft.content, "utf8");

  pendingDraft = null;

  return draft;
}
