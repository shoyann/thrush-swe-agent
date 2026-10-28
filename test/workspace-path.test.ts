import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyPendingWriteDraft } from "../src/lib/tools/pending-write";
import { writeFileTool } from "../src/lib/tools/write-file";
import {
  resolveWorkspacePath,
  withWorkspaceRoot,
} from "../src/lib/tools/workspace-path";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "thrush-workspace-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { root, workspace, outside };
}

test("new-file drafts cannot traverse an external directory symlink", async (t) => {
  const { workspace, outside } = await fixture(t);
  await symlink(outside, path.join(workspace, "linked"), "junction");

  await withWorkspaceRoot(workspace, async () => {
    for (const file of ["linked/new.txt", "linked/new/nested.txt"]) {
      const result = await writeFileTool.execute({ path: file, content: "escape" });
      assert.equal(result.ok, false);
      assert.match(result.content, /outside the configured workspace/);
      assert.equal(result.draft, undefined);
    }
  });
  assert.equal(existsSync(path.join(outside, "new.txt")), false);
  assert.equal(existsSync(path.join(outside, "new")), false);
});

test("draft approval rechecks parent symlinks before creating a file", async (t) => {
  const { workspace, outside } = await fixture(t);
  await mkdir(path.join(workspace, "linked"));
  await withWorkspaceRoot(workspace, async () => {
    const result = await writeFileTool.execute({
      path: "linked/new/nested.txt",
      content: "escape",
    });
    assert.equal(result.ok, true);
    assert.ok(result.draft);
    await rm(path.join(workspace, "linked"), { recursive: true });
    await symlink(outside, path.join(workspace, "linked"), "junction");

    await assert.rejects(
      applyPendingWriteDraft(result.draft),
      /outside the configured workspace/,
    );
  });
  assert.equal(existsSync(path.join(outside, "new")), false);
});

test("dangling symlinks are rejected instead of treated as missing directories", async (t) => {
  const { workspace, outside } = await fixture(t);
  const missingTarget = path.join(outside, "missing");
  await symlink(missingTarget, path.join(workspace, "linked"), "junction");
  await withWorkspaceRoot(workspace, async () => {
    assert.throws(() => resolveWorkspacePath("linked"));
    assert.throws(() => resolveWorkspacePath("linked/new/nested.txt"));
  });
  assert.equal(existsSync(missingTarget), false);
});

test("new nested files and symlinks within the workspace remain writable", async (t) => {
  const { workspace } = await fixture(t);
  await mkdir(path.join(workspace, "real"));
  await symlink(path.join(workspace, "real"), path.join(workspace, "linked"), "junction");
  await withWorkspaceRoot(workspace, async () => {
    for (const file of ["new/nested.txt", "linked/new/nested.txt"]) {
      const result = await writeFileTool.execute({ path: file, content: file });
      assert.equal(result.ok, true);
      assert.ok(result.draft);
      await applyPendingWriteDraft(result.draft);
      assert.equal(await readFile(path.join(workspace, file), "utf8"), file);
    }
  });
  assert.equal(
    await readFile(path.join(workspace, "real/new/nested.txt"), "utf8"),
    "linked/new/nested.txt",
  );
});

test("a symlinked workspace root supports creating nested files", async (t) => {
  const { root, workspace } = await fixture(t);
  const alias = path.join(root, "workspace-alias");
  await symlink(workspace, alias, "junction");
  await withWorkspaceRoot(alias, async () => {
    const result = await writeFileTool.execute({ path: "new/file.txt", content: "inside" });
    assert.equal(result.ok, true);
    assert.ok(result.draft);
    await applyPendingWriteDraft(result.draft);
  });
  assert.equal(await readFile(path.join(workspace, "new/file.txt"), "utf8"), "inside");
});

test("existing external symlinks and lexical parent traversal remain blocked", async (t) => {
  const { workspace, outside } = await fixture(t);
  await writeFile(path.join(outside, "existing.txt"), "outside");
  await symlink(outside, path.join(workspace, "linked"), "junction");
  await withWorkspaceRoot(workspace, async () => {
    assert.throws(
      () => resolveWorkspacePath("linked/existing.txt"),
      /outside the configured workspace/,
    );
    assert.throws(
      () => resolveWorkspacePath("../outside/new.txt"),
      /outside the configured workspace/,
    );
  });
});
