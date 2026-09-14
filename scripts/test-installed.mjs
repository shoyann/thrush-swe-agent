import { _electron as electron, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
const executablePath = process.argv[2];
if (!executablePath) throw new Error("Pass the installed Thrush.exe path.");
const application = await electron.launch({
  executablePath,
  args: [],
  cwd: process.env.TEMP,
  timeout: 90000,
});
try {
  const page = await application.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 100000 });
  const metadata = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    resources: process.resourcesPath,
    data: app.getPath("userData"),
  }));
  expect(metadata.packaged).toBe(true);
  if (process.env.THRUSH_EXPECT_VERSION)
    expect(metadata.version).toBe(process.env.THRUSH_EXPECT_VERSION);
  expect(metadata.resources).toBe(
    path.join(path.dirname(executablePath), "resources"),
  );
  const state = await page.evaluate(() => window.thrushDesktop.getState());
  expect(state.phase).toBe("ready");
  if (process.env.THRUSH_VERIFY_MODEL_KEY)
    expect(state.settings.hasKey).toBe(true);
  expect(state.settings.environment).toBe("native");
  expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
  if (state.settings.configured) {
    await page.getByRole("button", { name: "Settings", exact: false }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } else {
    await expect(
      page.getByRole("dialog", { name: "Set up your workspace" }),
    ).toBeVisible();
  }

  mkdirSync("test-results/desktop", { recursive: true });
  await page.screenshot({ path: "test-results/desktop/10-installed.png" });
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "installed executable",
        "bundled standalone runtime",
        "source-independent working directory",
        "sandboxed renderer",
        "setup/settings interface",
      ],
      ...metadata,
    }),
  );
} finally {
  await application.close();
}
