import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const root = process.cwd();
const profile = mkdtempSync(path.join(os.tmpdir(), "thrush-electron-test-"));
const screenshots = path.join(root, "test-results", "desktop");
mkdirSync(screenshots, { recursive: true });
const app = await electron.launch({
  args: [root],
  env: { ...process.env, THRUSH_TEST_PROFILE: profile },
  timeout: 90000,
});
try {
  const page = await app.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 100000 });
  await expect(
    page.getByRole("dialog", { name: "Set up your workspace" }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: path.join(screenshots, "01-setup.png") });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByRole("heading", { name: /Good work starts/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "02-welcome.png") });
  await page.getByRole("button", { name: "Open your first project" }).click();
  const sample = path.join(profile, "sample project 中文");
  mkdirSync(sample);
  await page.getByPlaceholder("C:\\Projects\\my-project").fill(sample);
  await page.getByPlaceholder("Use the folder name").fill("Desktop QA");
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /What are we/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "03-workspace.png") });
  await page.getByRole("button", { name: "Understand this project" }).click();
  await expect(
    page.getByRole("textbox", { name: "Describe your task" }),
  ).toHaveValue(/Explore/);
  await page.getByRole("tab", { name: "Auto", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Give it a goal/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "04-auto.png") });
  await page.getByRole("button", { name: "Settings", exact: false }).click();
  await page
    .getByRole("button", { name: "Runtime & tools", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your tools, in one place." }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "05-runtime.png") });
  await page.getByRole("button", { name: "Close dialog" }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  console.log(JSON.stringify({ status: "passed", profile, screenshots }));
} finally {
  await app.close();
}
