import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecommendedMiniPresetSnapshot,
  detectRecommendedEnvironment,
} from "../src/lib/auto/recommended-environment";

function withTempWorkspace(
  files: string[],
  run: (workspacePath: string) => void,
) {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "thrush-env-"));

  try {
    for (const file of files) {
      writeFileSync(path.join(workspacePath, file), "");
    }

    run(workspacePath);
  } finally {
    rmSync(workspacePath, { force: true, recursive: true });
  }
}

test("detectRecommendedEnvironment detects Node workspaces", () => {
  withTempWorkspace(["package.json"], (workspacePath) => {
    const environment = detectRecommendedEnvironment(workspacePath);

    assert.equal(environment.kind, "node");
    assert.equal(environment.dockerImage, "node:22-bookworm");
  });
});

test("detectRecommendedEnvironment detects Python workspaces", () => {
  withTempWorkspace(["pyproject.toml"], (workspacePath) => {
    const environment = detectRecommendedEnvironment(workspacePath);

    assert.equal(environment.kind, "python");
    assert.equal(environment.dockerImage, "python:3.12-bookworm");
  });
});

test("detectRecommendedEnvironment detects Rust workspaces", () => {
  withTempWorkspace(["Cargo.toml"], (workspacePath) => {
    const environment = detectRecommendedEnvironment(workspacePath);

    assert.equal(environment.kind, "rust");
    assert.equal(environment.dockerImage, "rust:bookworm");
  });
});

test("createRecommendedMiniPresetSnapshot hides Docker behind recommended defaults", () => {
  withTempWorkspace([], (workspacePath) => {
    const snapshot = createRecommendedMiniPresetSnapshot(workspacePath);

    assert.equal(snapshot.environment, "docker");
    assert.equal(snapshot.environmentKind, "generic");
    assert.equal(snapshot.dockerImage, "debian:bookworm");
    assert.equal(snapshot.networkPolicy, "default");
  });
});

test("Auto qualifies a desktop DeepSeek model without changing explicit provider names", (t) => {
  const saved = {
    provider: process.env.MODEL_PROVIDER,
    model: process.env.DEEPSEEK_MODEL,
    mini: process.env.DEEPSEEK_MINI_MODEL,
  };
  t.after(() => {
    for (const [name, value] of Object.entries({
      MODEL_PROVIDER: saved.provider,
      DEEPSEEK_MODEL: saved.model,
      DEEPSEEK_MINI_MODEL: saved.mini,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.MODEL_PROVIDER = "deepseek";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  delete process.env.DEEPSEEK_MINI_MODEL;
  withTempWorkspace([], (workspace) => {
    assert.equal(
      createRecommendedMiniPresetSnapshot(workspace).modelName,
      "deepseek/deepseek-v4-flash",
    );
    process.env.DEEPSEEK_MINI_MODEL = "openrouter/deepseek/deepseek-v4-flash";
    assert.equal(
      createRecommendedMiniPresetSnapshot(workspace).modelName,
      "openrouter/deepseek/deepseek-v4-flash",
    );
  });
});
