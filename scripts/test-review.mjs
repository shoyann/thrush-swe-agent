import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
const root = process.cwd(),
  profile = mkdtempSync(path.join(os.tmpdir(), "thrush-review-test-"));
const screenshots = path.join(root, "test-results", "desktop");
mkdirSync(screenshots, { recursive: true });
const application = await electron.launch({
  args: [root],
  env: { ...process.env, THRUSH_TEST_PROFILE: profile },
});
let db;
try {
  const page = await application.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 100000 });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Open your first project" }).click();
  const workspace = path.join(profile, "sample");
  mkdirSync(workspace);
  await page.getByPlaceholder("C:\\Projects\\my-project").fill(workspace);
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /What are we/ }),
  ).toBeVisible();
  db = new Database(path.join(profile, "environments/native/thrush.db"));
  const session = db
    .prepare("SELECT id,project_id FROM sessions LIMIT 1")
    .get();
  const setDraft = (id, file, content) =>
    db
      .prepare("UPDATE sessions SET context_json=? WHERE id=?")
      .run(
        JSON.stringify({
          pendingDraft: { id, path: file, content, kind: "write_file" },
        }),
        session.id,
      );
  db.prepare(
    "INSERT INTO messages(id,session_id,role,content,created_at) VALUES('fixture',?,'assistant',?,1)",
  ).run(
    session.id,
    "I prepared a small update.\n\n### What changes\n- Keeps the behavior focused\n- Includes a readable example\n\n```ts\nexport const greeting = 'Hello from Thrush';\n```",
  );
  setDraft("draft-qa", "hello.txt", "Approved by the UI smoke test.");
  await page.reload();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByRole("button", { name: "Approve changes" }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "07-approval.png") });
  await page.getByRole("button", { name: "Approve changes" }).click();
  await expect
    .poll(() => existsSync(path.join(workspace, "hello.txt")))
    .toBe(true);
  expect(readFileSync(path.join(workspace, "hello.txt"), "utf8")).toBe(
    "Approved by the UI smoke test.",
  );
  await expect(
    page.getByRole("button", { name: "Approve changes" }),
  ).not.toBeVisible();
  setDraft("draft-discard", "discard.txt", "Must not be written");
  await page.reload();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Discard draft" }).click();
  await expect(
    page.getByRole("button", { name: "Discard draft" }),
  ).not.toBeVisible();
  expect(existsSync(path.join(workspace, "discard.txt"))).toBe(false);
  db.prepare(
    "INSERT INTO auto_runs(id,project_id,preset_snapshot_json,task,status,workspace_path,result_status,created_at,updated_at) VALUES('qa-run',?,'{}','Improve the greeting','completed',?,'imported_history',1,1)",
  ).run(session.project_id, workspace);
  const insert = db.prepare(
    "INSERT INTO auto_artifacts(id,auto_run_id,type,label,content_text,metadata_json,created_at) VALUES(?,'qa-run',?,?,?,'{}',1)",
  );
  insert.run(
    "qa-report",
    "report",
    "Report",
    "# Task complete\n\nUpdated the greeting and verified the result.",
  );
  insert.run(
    "qa-diff",
    "diff",
    "Diff",
    "diff --git a/hello.ts b/hello.ts\n--- a/hello.ts\n+++ b/hello.ts\n@@ -1 +1 @@\n-export const hello = 'Hi';\n+export const hello = 'Hello from Thrush';",
  );
  insert.run("qa-logs", "logs", "Logs", "One test passed.");
  await page.reload();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Improve the greeting", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Diff", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".diff-line.added")).toContainText(
    "Hello from Thrush",
  );
  await page.screenshot({ path: path.join(screenshots, "08-diff.png") });
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(page.locator(".artifact-content")).toContainText(
    "One test passed.",
  );
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  for (const width of [1024, 800]) {
    await application.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 760),
      width,
    );
    await page.screenshot({
      path: path.join(screenshots, "09-layout-" + width + ".png"),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  }
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "real draft approval writes file",
        "discard leaves file absent",
        "Markdown",
        "Diff",
        "artifact switching",
        "1024/800px layouts",
      ],
      screenshots,
    }),
  );
} finally {
  db?.close();
  await application.close();
}
