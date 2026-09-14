import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import readline from "node:readline";
const platform = process.platform === "win32" ? "windows" : "linux";
const root = path.resolve("desktop-resources", platform);
const data = mkdtempSync(path.join(os.tmpdir(), "thrush-service-中文 "));
const workspace = path.join(data, "sample project");
mkdirSync(workspace);
writeFileSync(path.join(workspace, "README.md"), "# Smoke project\n");
const requests = [];
const fake = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push(JSON.parse(body));
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      id: "smoke",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The desktop smoke task completed.",
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }),
  );
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const token = "smoke-" + crypto.randomUUID();
const instance = crypto.randomUUID();
const executable = path.join(
  root,
  "node",
  platform === "windows" ? "node.exe" : "bin/node",
);
const child = spawn(executable, [path.join(root, "desktop/launcher.cjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  ...(platform === "linux" ? { detached: true } : {}),
});
let endpoint;
let logs = "";
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const x = JSON.parse(line);
    if (x.type === "port") endpoint = "http://127.0.0.1:" + x.port;
  } catch {}
  logs += line + "\n";
});
child.stderr.on("data", (b) => (logs += b.toString()));
child.stdin.write(
  JSON.stringify({
    root,
    env: {
      THRUSH_DESKTOP: "1",
      THRUSH_RESOURCE_DIR: root,
      THRUSH_DATA_DIR: data,
      THRUSH_RUNTIME_DIR: path.join(data, "runtime"),
      THRUSH_INSTANCE_ID: instance,
      AGENT_API_SECRET: token,
      MODEL_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "local-fixture-only",
      DEEPSEEK_MODEL: "smoke",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:" + fake.address().port + "/v1",
    },
  }) + "\n",
);
async function api(route, body) {
  return fetch(endpoint + route, {
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
}
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (endpoint) {
      try {
        const r = await api("/api/desktop");
        if (r.ok && (await r.json()).instance === instance) {
          ready = true;
          break;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, "Standalone server startup failed: " + logs);
  for (const route of [
    "/api/projects",
    "/api/desktop",
    "/api/auto-runs?projectId=none",
  ])
    assert.equal((await fetch(endpoint + route)).status, 401);
  const initial = await (await api("/api/projects")).json();
  assert.equal(initial.projects.length, 0);
  const created = await (
    await api("/api/projects", {
      workspacePath: workspace,
      name: "Smoke project",
      confirmWorkspace: true,
    })
  ).json();
  assert.equal(created.project.name, "Smoke project");
  const sid = created.snapshot.projects[0].sessions[0].id;
  const stream = await api("/api/agent", {
    sessionId: sid,
    task: "Say hello without using tools.",
    stream: true,
  });
  assert.equal(stream.status, 200);
  const text = await stream.text();
  assert.ok(requests.length > 0);
  assert.deepEqual(requests[0].thinking, { type: "disabled" });
  assert.equal(requests[0].extra_body, undefined);
  assert.ok(text.includes('"type":"done"'), text);
  const detail = await (await api("/api/sessions/" + sid)).json();
  assert.ok(detail.session.messages.length >= 2);
  const check = await (
    await api("/api/auto-runs/readiness?projectId=" + created.project.id)
  ).json();
  assert.equal(check.readiness.canCreateRun, false);
  assert.equal(
    (await api("/api/desktop", { action: "import", path: data })).status,
    400,
  );
  console.log(
    JSON.stringify({
      platform,
      status: "passed",
      checks: [
        "standalone startup",
        "all API authentication",
        "persistent projects",
        "SSE with local model fixture",
        "Auto readiness blocking",
        "invalid import",
      ],
      data,
    }),
  );
} finally {
  try {
    await api("/api/desktop", { action: "shutdown" });
  } catch {}
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  fake.close();
}
