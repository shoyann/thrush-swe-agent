import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runtimePaths } from "../src/lib/runtime/paths";
import { importLegacyData } from "../src/lib/runtime/import-data";
test("desktop data paths and import preserve the source while invalidating stale actions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "thrush desktop 中文 "));
  const source = path.join(root, "old data");
  const target = path.join(root, "new data");
  mkdirSync(source);
  const resource = process.cwd();
  process.env.THRUSH_DATA_DIR = target;
  process.env.THRUSH_RESOURCE_DIR = resource;
  assert.equal(runtimePaths().database, path.join(target, "thrush.db"));
  assert.equal(
    runtimePaths().migrations,
    path.join(resource, "src/lib/db/migrations"),
  );
  const db = new Database(path.join(source, "thrush.db"));
  db.exec(
    "CREATE TABLE _migrations (filename TEXT PRIMARY KEY, executed_at INTEGER NOT NULL)",
  );
  for (const file of readdirSync(runtimePaths().migrations).sort()) {
    db.exec(readFileSync(path.join(runtimePaths().migrations, file), "utf8"));
    db.prepare("INSERT INTO _migrations VALUES (?,0)").run(file);
  }
  db.prepare("INSERT INTO _migrations VALUES (?,0)").run("999_future.sql");
  await assert.rejects(importLegacyData(source), /newer Thrush/);
  db.prepare("DELETE FROM _migrations WHERE filename=?").run("999_future.sql");
  db.prepare("INSERT INTO projects VALUES ('p','Project',?,1,1,1)").run(root);
  db.prepare(
    "INSERT INTO sessions (id,project_id,title,context_json,steps_json,created_at,updated_at,auto_approve) VALUES ('s','p','Task',?,'[]',1,1,1)",
  ).run(
    JSON.stringify({
      pendingDraft: { id: "draft", content: "stale" },
      pendingWorkspaceSwitch: { id: "switch" },
      autoApprove: true,
    }),
  );
  db.prepare(
    "INSERT INTO messages VALUES ('m','s','user','Hello',NULL,1)",
  ).run();
  db.prepare(
    "INSERT INTO auto_runs(id,project_id,preset_snapshot_json,task,status,workspace_path,worktree_path,branch_name,created_at,updated_at) VALUES('r','p','{}','Old task','running',?,?, 'auto/r',1,1)",
  ).run(root, path.join(source, "auto-runs/r/worktree"));
  const artifact = path.join(source, "auto-runs/r/artifacts/report.md");
  mkdirSync(path.dirname(artifact), { recursive: true });
  writeFileSync(artifact, "# Previous result");
  db.prepare(
    "INSERT INTO auto_artifacts VALUES ('a','r','report','Report',NULL,?,'{}',1)",
  ).run(artifact);
  const result = await importLegacyData(source);
  assert.equal(result.projects, 1);
  assert.equal(result.messages, 1);
  assert.ok(existsSync(path.join(result.backup, "source.db")));
  const imported = new Database(runtimePaths().database, { readonly: true });
  const context = JSON.parse(
    (
      imported.prepare("SELECT context_json FROM sessions").get() as {
        context_json: string;
      }
    ).context_json,
  );
  assert.equal(context.pendingDraft, undefined);
  assert.equal(context.pendingWorkspaceSwitch, undefined);
  assert.equal(context.autoApprove, false);
  const run = imported
    .prepare("SELECT status,worktree_path,result_status FROM auto_runs")
    .get() as {
    status: string;
    worktree_path: string | null;
    result_status: string;
  };
  assert.equal(run.status, "failed");
  assert.equal(run.worktree_path, null);
  assert.equal(run.result_status, "imported_history");
  const copy = imported
    .prepare("SELECT file_path FROM auto_artifacts")
    .get() as { file_path: string };
  assert.notEqual(copy.file_path, artifact);
  assert.equal(readFileSync(copy.file_path, "utf8"), "# Previous result");
  assert.equal(
    (db.prepare("SELECT status FROM auto_runs").get() as { status: string })
      .status,
    "running",
  );
  assert.ok(
    JSON.parse(
      (
        db.prepare("SELECT context_json FROM sessions").get() as {
          context_json: string;
        }
      ).context_json,
    ).pendingDraft,
  );
  await assert.rejects(importLegacyData(source), /empty environment/);
  imported.close();
  db.close();
  delete process.env.THRUSH_DATA_DIR;
  delete process.env.THRUSH_RESOURCE_DIR;
});
