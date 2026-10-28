import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPendingWriteDraft } from "../src/lib/tools/pending-write";
import { replaceTextTool } from "../src/lib/tools/replace-text";
import { withWorkspaceRoot } from "../src/lib/tools/workspace-path";

for (const replacement of [
  "$$",
  "$&",
  "$`",
  "$'",
  "$1",
  "const price = '$$'; // $& $` $'",
]) {
  test(`replace_text inserts ${JSON.stringify(replacement)} literally in the approved file`, async (t) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "thrush-replace-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const file = path.join(workspace, "example.txt");
    const original = "before TARGET after";
    await writeFile(file, original);

    await withWorkspaceRoot(workspace, async () => {
      const result = await replaceTextTool.execute({
        path: "example.txt",
        old_text: "TARGET",
        new_text: replacement,
      });

      assert.equal(result.ok, true);
      assert.ok(result.draft);
      assert.equal(result.draft.content, `before ${replacement} after`);
      assert.equal(await readFile(file, "utf8"), original);

      await applyPendingWriteDraft(result.draft);
      assert.equal(await readFile(file, "utf8"), `before ${replacement} after`);
    });
  });
}

test("replace_text still requires one exact match and supports deletion", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "thrush-replace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, "example.txt");
  await writeFile(file, "before TARGET TARGET after");

  await withWorkspaceRoot(workspace, async () => {
    for (const oldText of ["MISSING", "TARGET"]) {
      const result = await replaceTextTool.execute({
        path: "example.txt",
        old_text: oldText,
        new_text: "$&",
      });
      assert.equal(result.ok, false);
      assert.equal(result.draft, undefined);
      assert.equal(await readFile(file, "utf8"), "before TARGET TARGET after");
    }

    const result = await replaceTextTool.execute({
      path: "example.txt",
      old_text: "TARGET TARGET ",
      new_text: "",
    });
    assert.equal(result.ok, true);
    assert.ok(result.draft);
    await applyPendingWriteDraft(result.draft);
    assert.equal(await readFile(file, "utf8"), "before after");
  });
});
