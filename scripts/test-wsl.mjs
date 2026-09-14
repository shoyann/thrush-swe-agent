import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const profile = mkdtempSync(path.join(os.tmpdir(), "thrush-wsl-test-"));
const screenshots = path.join(root, "test-results", "desktop");
mkdirSync(screenshots, { recursive: true });
const application = await electron.launch({
  args: [root],
  env: { ...process.env, THRUSH_TEST_PROFILE: profile },
  timeout: 90000,
});
try {
  const page = await application.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 100000 });
  const initial = await page.evaluate(() => window.thrushDesktop.getState());
  if (!initial.distributions.length)
    throw new Error(
      "No supported WSL distribution available for the required smoke test.",
    );
  const distribution = initial.distributions[0];
  await page.evaluate(
    ({ settings, distribution }) => {
      void window.thrushDesktop
        .configure({ ...settings, environment: "wsl", distribution })
        .catch(() => {});
    },
    { settings: initial.settings, distribution },
  );
  await expect
    .poll(
      async () => {
        try {
          const s = await page.evaluate(() => window.thrushDesktop.getState());
          return s.settings.environment === "wsl" ? s.phase : "waiting";
        } catch {
          return "loading";
        }
      },
      { timeout: 180000 },
    )
    .toBe("ready");
  await expect(
    page.getByRole("heading", { name: /Good work starts/ }),
  ).toBeVisible({ timeout: 20000 });
  const state = await page.evaluate(() => window.thrushDesktop.getState());
  expect(state.settings.environment).toBe("wsl");
  const workspace = "/tmp/thrush-wsl-qa-" + crypto.randomUUID();
  execFileSync(
    "wsl.exe",
    ["-d", distribution, "--exec", "mkdir", "-p", workspace],
    { windowsHide: true },
  );
  await page.getByRole("button", { name: "Open your first project" }).click();
  await page.getByPlaceholder("/home/you/projects/my-project").fill(workspace);
  await page.getByPlaceholder("Use the folder name").fill("Ubuntu QA");
  await page.getByRole("button", { name: "Open project", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /What are we/ }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, "06-wsl.png") });
  await page.evaluate((settings) => {
    void window.thrushDesktop
      .configure({ ...settings, environment: "native", distribution: "" })
      .catch(() => {});
  }, initial.settings);
  await expect
    .poll(
      async () => {
        try {
          const s = await page.evaluate(() => window.thrushDesktop.getState());
          return s.phase === "ready" && s.settings.environment === "native";
        } catch {
          return false;
        }
      },
      { timeout: 100000 },
    )
    .toBe(true);
  await expect(
    page.getByRole("heading", { name: /Good work starts/ }),
  ).toBeVisible();
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "Windows to WSL",
        "WSL project creation",
        "WSL to Windows",
        "isolated project histories",
      ],
      distribution,
      profile,
    }),
  );
} finally {
  await application.close();
}
