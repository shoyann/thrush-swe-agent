import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getDb } from "../src/lib/db/connection";
import { createProject } from "../src/lib/db/store";
import {
  claimNextQueuedAutoRun,
  createAutoRun,
  getActiveAutoRunForProject,
  listAutoEvents,
  markAutoRunStatus,
  requestAutoRunCancel,
} from "../src/lib/db/auto-store";

test("Auto cancellation preserves the queue lifecycle", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "thrush-auto-cancel-"));
  const previousDataDir = process.env.THRUSH_DATA_DIR;
  const previousResourceDir = process.env.THRUSH_RESOURCE_DIR;
  process.env.THRUSH_DATA_DIR = root;
  process.env.THRUSH_RESOURCE_DIR = process.cwd();
  t.after(() => {
    getDb().close();
    if (previousDataDir === undefined) delete process.env.THRUSH_DATA_DIR;
    else process.env.THRUSH_DATA_DIR = previousDataDir;
    if (previousResourceDir === undefined) delete process.env.THRUSH_RESOURCE_DIR;
    else process.env.THRUSH_RESOURCE_DIR = previousResourceDir;
    rmSync(root, { recursive: true, force: true });
  });

  function createQueuedRun() {
    const project = createProject({
      confirmWorkspace: true,
      name: "Cancellation test",
      workspacePath: mkdtempSync(path.join(root, "project-")),
    })!;
    return createAutoRun({ projectId: project.id, task: "Fix the test" })!;
  }

  await t.test("canceling a queued run releases the project for another run", () => {
    const run = createQueuedRun();
    const canceled = requestAutoRunCancel(run.id, "Changed my mind")!;
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.cancelRequested, true);
    assert.equal(canceled.resultStatus, "canceled");
    assert.equal(canceled.failureCategory, "canceled");
    assert.equal(canceled.startedAt, null);
    assert.ok(canceled.finishedAt);
    assert.equal(getActiveAutoRunForProject(run.projectId), null);
    assert.equal(claimNextQueuedAutoRun(), null);
    assert.deepEqual(
      listAutoEvents(run.id).map((event) => event.type),
      ["queued", "cancel_requested", "canceled"],
    );
    const replacement = createAutoRun({
      projectId: run.projectId,
      task: "Try again",
    })!;
    assert.equal(claimNextQueuedAutoRun()?.id, replacement.id);
    markAutoRunStatus({ autoRunId: replacement.id, status: "canceled" });
  });

  await t.test("claimed runs stay active until the worker stops them", () => {
    for (const status of ["preparing", "running", "reporting"] as const) {
      const run = createQueuedRun();
      markAutoRunStatus({ autoRunId: run.id, status });
      const requested = requestAutoRunCancel(run.id)!;
      assert.equal(requested.status, status);
      assert.equal(requested.cancelRequested, true);
      assert.equal(requested.finishedAt, null);
      assert.equal(getActiveAutoRunForProject(run.projectId)?.id, run.id);
      assert.deepEqual(
        listAutoEvents(run.id).map((event) => event.type),
        ["queued", "cancel_requested"],
      );
      markAutoRunStatus({ autoRunId: run.id, status: "canceled" });
    }
  });

  await t.test("repeated cancellation leaves the terminal result unchanged", () => {
    const run = createQueuedRun();
    const canceled = requestAutoRunCancel(run.id)!;
    const events = listAutoEvents(run.id);
    assert.deepEqual(requestAutoRunCancel(run.id), canceled);
    assert.deepEqual(listAutoEvents(run.id), events);
    for (const status of ["completed", "failed"] as const) {
      const finished = createQueuedRun();
      markAutoRunStatus({ autoRunId: finished.id, status });
      const result = requestAutoRunCancel(finished.id)!;
      assert.equal(result.status, status);
      assert.equal(result.cancelRequested, false);
      assert.equal(listAutoEvents(finished.id).length, 1);
    }
  });

  await t.test("unknown runs return null without inserting an orphan event", () => {
    assert.equal(requestAutoRunCancel("missing-run"), null);
    assert.deepEqual(listAutoEvents("missing-run"), []);
  });
});
