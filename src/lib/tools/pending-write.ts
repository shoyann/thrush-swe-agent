import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WriteFileDraft } from "@/lib/tools/types";
import { resolveWorkspacePath } from "@/lib/tools/workspace-path";

export function hashContent(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export async function readFileHash(targetPath: string): Promise<string | null> {
  try {
    return hashContent(await readFile(targetPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function applyPendingWriteDraft(draft: WriteFileDraft | null) {
  if (!draft) {
    return null;
  }

  const targetPath = resolveWorkspacePath(draft.path);

  const currentHash = await readFileHash(targetPath);
  // An interrupted request may have written successfully before its final checkpoint.
  if (currentHash === hashContent(draft.content))
    return {
      draft,
      changed: draft.baseHash !== undefined && draft.baseHash !== currentHash,
    };
  if (draft.baseHash !== undefined && currentHash !== draft.baseHash)
    throw new Error(
      "File changed after the draft was prepared. Discard this draft and read the file again.",
    );

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, draft.content, "utf8");

  return { draft, changed: true };
}
