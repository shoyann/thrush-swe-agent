// Explicit opt-in integration test: uses the API key already encrypted by Thrush.
import { _electron as electron, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const environment = process.argv[2] || "native";
if (!["native", "wsl"].includes(environment))
  throw new Error("Choose native or wsl.");
const source = JSON.parse(
  readFileSync(path.join(process.env.APPDATA, "Thrush/desktop.json"), "utf8"),
);
if (!source.encryptedKeys?.deepseek)
  throw new Error("Configure DeepSeek in Thrush first.");
const profile = path.join(root, ".desktop-cache", "live-" + environment);
mkdirSync(profile, { recursive: true });
copyFileSync(
  path.join(process.env.APPDATA, "Thrush/Local State"),
  path.join(profile, "Local State"),
);
writeFileSync(
  path.join(profile, "desktop.json"),
  JSON.stringify({
    settings: {
      ...source.settings,
      environment,
      distribution: environment === "wsl" ? "Ubuntu" : "",
      provider: "deepseek",
      configured: true,
    },
    encryptedKeys: source.encryptedKeys,
  }),
);
const results = {
  date: new Date().toISOString(),
  environment,
  model: source.settings.model,
  checks: [],
  profile,
};
const application = await electron.launch({
  args: [root],
  env: {
    ...process.env,
    THRUSH_TEST_PROFILE: profile,
    AUTO_RUN_COST_LIMIT: "0.2",
    AUTO_RUN_STEP_LIMIT: "12",
    AUTO_RUN_WALL_TIME_LIMIT_SECONDS: process.env.THRUSH_LIVE_TIMEOUT_CHECK
      ? "60"
      : "180",
  },
  timeout: 90000,
});
let page;
const mark = (check, detail) => {
  results.checks.push({ check, ...detail });
  console.log(JSON.stringify({ check, ...detail }));
};
function command(file, args, options = {}) {
  return execFileSync(
    environment === "wsl" ? "wsl.exe" : file,
    environment === "wsl" ? ["-d", "Ubuntu", "--exec", file, ...args] : args,
    { encoding: "utf8", windowsHide: true, timeout: 30000, ...options },
  );
}
const workspace =
  environment === "wsl"
    ? "/tmp/thrush-live-" + crypto.randomUUID()
    : path.join(profile, "project-" + crypto.randomUUID());
function fileExists(file) {
  return environment === "native"
    ? existsSync(file)
    : command("python3", [
        "-c",
        "import pathlib,sys;print(pathlib.Path(sys.argv[1]).exists())",
        file,
      ]).trim() === "True";
}
function readFile(file) {
  return environment === "native"
    ? readFileSync(file, "utf8")
    : command("cat", [file]);
}
const git = (args) => command("git", ["-C", workspace, ...args]);
try {
  page = await application.firstWindow();
  await page.waitForURL("thrush://app/", { timeout: 180000 });
  const state = await page.evaluate(() => window.thrushDesktop.getState());
  assert.equal(state.settings.environment, environment);
  assert.equal(state.settings.hasKey, true);
  async function api(route, body) {
    const result = await page.evaluate(
      async ({ route, body }) => {
        const response = await fetch(route, {
          headers: { "content-type": "application/json" },
          ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(210000),
        });
        return { status: response.status, body: await response.text() };
      },
      { route, body },
    );
    if (result.status >= 400)
      throw new Error(
        route + ": " + result.status + " " + result.body.slice(0, 1000),
      );
    return JSON.parse(result.body);
  }
  async function assist(task, sessionId) {
    const result = await page.evaluate(
      async ({ task, sessionId }) => {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task, sessionId, stream: true }),
          signal: AbortSignal.timeout(210000),
        });
        return { status: response.status, text: await response.text() };
      },
      { task, sessionId },
    );
    assert.equal(result.status, 200);
    const events = result.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const error = events.find((event) => event.type === "error");
    if (error) throw new Error(error.message);
    assert.ok(
      events.some((event) => event.type === "done"),
      "SSE did not complete",
    );
    return events;
  }
  const marker = "THRUSH_" + crypto.randomUUID().replaceAll("-", "");
  const files = {
    "README.md":
      "# Live desktop validation\nVALIDATION_MARKER=" + marker + "\n",
    "requirements.txt": "",
    ".gitignore": "__pycache__/\n",
    "greeting.py": "def add(a, b):\n    return a - b\n",
    "test_greeting.py":
      "import unittest\nfrom greeting import add\nclass GreetingTest(unittest.TestCase):\n    def test_positive(self): self.assertEqual(add(2, 3), 5)\n    def test_negative(self): self.assertEqual(add(-2, 1), -1)\nif __name__ == '__main__': unittest.main()\n",
  };
  if (environment === "native") {
    mkdirSync(workspace, { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(workspace, name), content);
  } else {
    command(
      "python3",
      [
        "-c",
        "import json,pathlib,sys;d=json.load(sys.stdin);r=pathlib.Path(d['root']);r.mkdir(parents=True);[(r/n).write_text(c) for n,c in d['files'].items()]",
      ],
      { input: JSON.stringify({ root: workspace, files }) },
    );
  }
  git(["init"]);
  git(["config", "user.name", "Thrush validation"]);
  git(["config", "user.email", "validation@thrush.invalid"]);
  git(["add", "."]);
  git(["commit", "-m", "Initial validation fixture"]);
  const projectName =
    "Live DeepSeek · " + environment + " · " + marker.slice(-6);
  const created = await api("/api/projects", {
    workspacePath: workspace,
    name: projectName,
    confirmWorkspace: true,
  });
  const projectId = created.project.id;
  const sid = created.snapshot.projects.find(
    (project) => project.id === projectId,
  ).sessions[0].id;
  results.workspace = workspace;
  results.projectId = projectId;
  const reply = await assist(
    "What is 17 plus 26? Reply in one short sentence, without tools.",
    sid,
  );
  assert.ok(JSON.stringify(reply).includes("43"));
  mark("live DeepSeek conversation + SSE", { passed: true });
  const toolReply = await assist(
    "Inspect README.md and report its exact VALIDATION_MARKER value. Do not edit files.",
    sid,
  );
  assert.ok(JSON.stringify(toolReply).includes(marker));
  mark("live file inspection", { passed: true });
  await assist(
    "Use write_file to create approval-check.txt with exactly DESKTOP_APPROVAL_OK as its content. Prepare a draft and wait for my approval.",
    sid,
  );
  assert.equal(fileExists(workspace + "/approval-check.txt"), false);
  await page.reload();
  // Select the session created in this run if an earlier validation project is present.
  const sessionButton = page.getByRole("button", {
    name: projectName,
    exact: true,
  });
  if (await sessionButton.count()) await sessionButton.first().click();
  const pending = await api("/api/sessions/" + sid);
  assert.ok(
    pending.session.sessionContext?.pendingDraft ||
      pending.session.context?.pendingDraft,
    "No pending draft was created.",
  );
  // Select the fresh session through its visible task in the project sidebar.
  await page.getByText("New session", { exact: true }).last().click();
  await expect(
    page.getByRole("button", { name: "Approve changes" }),
  ).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Approve changes" }).click();
  await expect
    .poll(() => fileExists(workspace + "/approval-check.txt"), {
      timeout: 30000,
    })
    .toBe(true);
  assert.equal(
    readFile(workspace + "/approval-check.txt").trim(),
    "DESKTOP_APPROVAL_OK",
  );
  mark("live draft + user approval", { passed: true });
  git(["add", "."]);
  git(["commit", "-m", "Approve validation draft"]);
  const dependencies = await api("/api/desktop?action=dependencies");
  if (!dependencies.mini.ok) {
    await api("/api/desktop", { action: "prepare" });
    let previous;
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const health = await api("/api/desktop");
      const line = health.setup.lines
        .join("")
        .trim()
        .split("\n")
        .at(-1)
        ?.slice(0, 180);
      if (line && line !== previous && i % 10 === 0) {
        console.log(JSON.stringify({ setup: line }));
        previous = line;
      }
      if (!health.setup.running) break;
    }
  }
  const ready = await api("/api/auto-runs/readiness?projectId=" + projectId);
  mark("Auto readiness", {
    passed: ready.readiness.canCreateRun,
    readiness: ready.readiness,
  });
  assert.equal(ready.readiness.canCreateRun, true);
  const started = await api("/api/auto-runs", {
    projectId,
    task: "Fix greeting.py so add(a, b) returns their sum, including negative numbers. Run python -m unittest -v to verify. Modify only greeting.py and submit when the two tests pass. Do not create a Git commit.",
  });
  assert.equal(
    started.run.presetSnapshot.costLimit,
    0.2,
    "Auto cost limit was not forwarded",
  );
  assert.equal(
    started.run.presetSnapshot.stepLimit,
    12,
    "Auto step limit was not forwarded",
  );
  assert.equal(
    started.run.presetSnapshot.wallTimeLimitSeconds,
    process.env.THRUSH_LIVE_TIMEOUT_CHECK ? 60 : 180,
    "Auto deadline was not forwarded",
  );
  results.autoRunId = started.run.id;
  let completed;
  for (let i = 0; i < 150; i++) {
    completed = await api("/api/auto-runs/" + started.run.id);
    if (["completed", "failed", "canceled"].includes(completed.run.status))
      break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  results.auto = completed;
  assert.equal(
    completed.run.status,
    "completed",
    completed.run.failureMessage || "Auto did not complete",
  );
  assert.ok(
    completed.artifacts.some(
      (artifact) =>
        artifact.type === "diff" && artifact.contentText?.includes("a + b"),
    ),
  );
  assert.ok(
    readFile(workspace + "/greeting.py").includes("a - b"),
    "Main workspace was changed by Auto",
  );
  assert.ok(
    completed.artifacts.some(
      (artifact) => artifact.type === "report" && artifact.contentText,
    ),
  );
  assert.equal(
    command("docker", [
      "ps",
      "-a",
      "--filter",
      "name=^/thrush-" + started.run.id + "$",
      "--format",
      "{{.ID}}",
    ]).trim(),
    "",
    "Completed run leaked a container.",
  );
  mark("live Docker Auto fix + tests + report + isolated diff", {
    passed: true,
    runId: started.run.id,
  });
  const canceled = await api("/api/auto-runs", {
    projectId,
    task: "For this cancellation check, execute sleep 90 as your first command. After it finishes, create must-not-exist.txt. Do not skip the initial sleep.",
  });
  const containerName = "thrush-" + canceled.run.id;
  await expect
    .poll(
      () =>
        command("docker", [
          "ps",
          "--filter",
          "name=^/" + containerName + "$",
          "--format",
          "{{.ID}}",
        ]).trim(),
      { timeout: 60000 },
    )
    .not.toBe("");
  await api("/api/auto-runs/" + canceled.run.id + "/cancel", {
    reason: "Live desktop cancellation verification",
  });
  await expect
    .poll(
      async () => (await api("/api/auto-runs/" + canceled.run.id)).run.status,
      { timeout: 60000 },
    )
    .toBe("canceled");
  await expect
    .poll(
      () =>
        command("docker", [
          "ps",
          "-a",
          "--filter",
          "name=^/" + containerName + "$",
          "--format",
          "{{.ID}}",
        ]).trim(),
      { timeout: 30000 },
    )
    .toBe("");
  mark("live cancellation + owned-container cleanup", {
    passed: true,
    runId: canceled.run.id,
  });
  if (process.env.THRUSH_LIVE_TIMEOUT_CHECK) {
    const timed = await api("/api/auto-runs", {
      projectId,
      task: "Execute sleep 90 as your first command, then submit. This is a timeout verification; do not skip or shorten the sleep.",
    });
    const owned = "thrush-" + timed.run.id;
    await expect
      .poll(
        () =>
          command("docker", [
            "ps",
            "--filter",
            "name=^/" + owned + "$",
            "--format",
            "{{.ID}}",
          ]).trim(),
        { timeout: 45000 },
      )
      .not.toBe("");
    let timedResult;
    await expect
      .poll(
        async () => {
          timedResult = await api("/api/auto-runs/" + timed.run.id);
          return timedResult.run.status;
        },
        { timeout: 90000 },
      )
      .toBe("failed");
    assert.equal(timedResult.run.failureCategory, "timeout");
    assert.equal(
      command("docker", [
        "ps",
        "-a",
        "--filter",
        "name=^/" + owned + "$",
        "--format",
        "{{.ID}}",
      ]).trim(),
      "",
    );
    mark("wall deadline + owned-container cleanup", {
      passed: true,
      runId: timed.run.id,
    });
  }
  results.status = "passed";
} catch (error) {
  results.status = "failed";
  results.error = String(error.message).replace(
    /sk-[a-zA-Z0-9_-]+/g,
    "[redacted]",
  );
  console.error(results.error);
  if (page)
    await page
      .screenshot({ path: path.join(profile, "failure.png") })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  mkdirSync("test-results/live", { recursive: true });
  writeFileSync(
    "test-results/live/" + environment + ".json",
    JSON.stringify(results, null, 2),
  );
  await application
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    })
    .catch(() => {});
  await application.close();
}
