import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteFileDraft } from "@/lib/tools/types";
import { resolveWorkspacePath } from "@/lib/tools/workspace-path";

export async function applyPendingWriteDraft(draft: WriteFileDraft | null) {
  if (!draft) {
    return null;
  }

  const targetPath = resolveWorkspacePath(draft.path);

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, draft.content, "utf8");

  return draft;
}
