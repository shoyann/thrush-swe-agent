import assert from "node:assert/strict";
import test from "node:test";
import {
  dockerCheck,
  gitCheck,
  modelCheck,
} from "../src/lib/auto/readiness-checks";

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();

  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("docker readiness reports unavailable Docker as a blocking check", async () => {
  const check = await dockerCheck(
    { dockerImage: "python:3.12-bookworm", environment: "docker" },
    async () => {
      throw new Error("docker: command not found");
    },
  );

  assert.equal(check.ok, false);
  assert.equal(check.required, true);
  assert.equal(check.category, "docker_unavailable");
  assert.match(check.message, /Docker is not available/);
});

test("docker readiness is optional for local execution presets", async () => {
  const check = await dockerCheck(
    { environment: "local" },
    async () => {
      throw new Error("should not be called");
    },
  );

  assert.equal(check.ok, true);
  assert.equal(check.required, false);
});

test("git readiness blocks dirty workspaces", async () => {
  const check = await gitCheck("/workspace", async () => ({
    stderr: "",
    stdout: " M README.md\n",
  }));

  assert.equal(check.ok, false);
  assert.equal(check.category, "workspace_dirty");
  assert.match(check.message, /uncommitted changes/);
});

test("model readiness explains the missing provider key", () => {
  withEnv(
    {
      ANTHROPIC_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      MODEL_PROVIDER: "deepseek",
      OPENAI_API_KEY: undefined,
    },
    () => {
      const check = modelCheck({ modelName: "deepseek/deepseek-chat" });

      assert.equal(check.ok, false);
      assert.equal(check.category, "model_config_missing");
      assert.match(check.message, /DEEPSEEK_API_KEY/);
    },
  );
});
