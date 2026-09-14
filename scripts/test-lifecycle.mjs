import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
const root = process.cwd();
const profile = mkdtempSync(path.join(os.tmpdir(), "thrush-lifecycle-"));
const fake = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  await new Promise((resolve) => setTimeout(resolve, 8000));
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "fixture",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Background work completed." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const application = await electron.launch({
  args: [root],
  env: { ...process.env, THRUSH_TEST_PROFILE: profile },
  timeout: 90000,
});
try {
  const page = await application.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 100000 });
  const settings = (await page.evaluate(() => window.thrushDesktop.getState()))
    .settings;
  await page.evaluate(
    (value) => {
      void window.thrushDesktop.configure(value).catch(() => {});
    },
    {
      ...settings,
      provider: "openai",
      model: "fixture",
      apiKey: "lifecycle-fixture-key",
      baseURL: "http://127.0.0.1:" + fake.address().port + "/v1",
    },
  );
  await expect
    .poll(
      async () => {
        try {
          const state = await page.evaluate(() =>
            window.thrushDesktop.getState(),
          );
          return (
            state.phase === "ready" && state.settings.provider === "openai"
          );
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
  const workspace = path.join(profile, "workspace");
  mkdirSync(workspace);
  const created = await page.evaluate(
    async (workspacePath) =>
      (
        await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspacePath,
            name: "Lifecycle QA",
            confirmWorkspace: true,
          }),
        })
      ).json(),
    workspace,
  );
  const sid = created.snapshot.projects[0].sessions[0].id;
  await page.evaluate((sessionId) => {
    window.lifecycleResult = null;
    void fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        task: "Say hello without tools.",
        stream: true,
      }),
    })
      .then((r) => r.text())
      .then((text) => {
        window.lifecycleResult = text;
      });
  }, sid);
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await (await fetch("/api/desktop")).json()).active,
      ),
    )
    .toBeGreaterThan(0);
  const blocked = await page.evaluate(async (settings) => {
    try {
      await window.thrushDesktop.configure(settings);
      return false;
    } catch (error) {
      return error.message.includes("active task");
    }
  }, settings);
  expect(blocked).toBe(true);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    )
    .toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.lifecycleResult), { timeout: 20000 })
    .toContain('"type":"done"');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].show(),
  );
  // A second launch must exit, leaving the original application intact.
  const second = spawn(application.process().spawnfile, [root], {
    env: { ...process.env, THRUSH_TEST_PROFILE: profile },
    windowsHide: true,
    stdio: "ignore",
  });
  const secondExit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      second.kill();
      reject(new Error("Second instance did not exit."));
    }, 15000);
    second.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  expect(secondExit).toBe(0);
  expect(application.process().exitCode).toBe(null);
  expect(
    readFileSync(path.join(profile, "desktop.json"), "utf8"),
  ).not.toContain("lifecycle-fixture-key");
  // Kill only the bundled Node service owned by this test Electron process.
  const parentPid = await application.evaluate(() => process.pid);
  const raw = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq " +
        parentPid +
        " -and $_.Name -eq 'node.exe' } | Select-Object -ExpandProperty ProcessId",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const ownedPid = Number(raw);
  expect(Number.isInteger(ownedPid) && ownedPid > 0).toBe(true);
  execFileSync("taskkill.exe", ["/pid", String(ownedPid), "/t", "/f"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.thrushDesktop.getState()).phase,
        ),
      { timeout: 15000 },
    )
    .toBe("error");
  await page.evaluate(() => {
    void window.thrushDesktop.restart().catch(() => {});
  });
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(
            async () => (await window.thrushDesktop.getState()).phase,
          );
        } catch {
          return "loading";
        }
      },
      { timeout: 90000 },
    )
    .toBe("ready");
  await expect
    .poll(async () => {
      try {
        return await page.evaluate(
          async () =>
            (await (await fetch("/api/projects")).json()).projects[0]?.name,
        );
      } catch {
        return "";
      }
    })
    .toBe("Lifecycle QA");
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "active environment lock",
        "close to tray",
        "background SSE completion",
        "single instance",
        "encrypted key at rest",
        "service crash recovery",
        "history persistence",
      ],
      profile,
    }),
  );
} finally {
  await application.close();
  fake.close();
}
