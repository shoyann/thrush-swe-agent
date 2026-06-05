import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { __safeCommandTestInternals, safeCommandTool } from "../src/lib/tools/safe-command";

const { buildAllowedCommandCall } = __safeCommandTestInternals;

function createWorkspace(files: Record<string, string>) {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "thrush-safe-command-"));

  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(path.join(workspaceRoot, fileName), content);
  }

  return workspaceRoot;
}

function packageJson(scripts: Record<string, string>) {
  return JSON.stringify({ scripts });
}

function withWorkspaceRoot<T>(workspaceRoot: string, callback: () => T): T {
  const previousRoot = process.env.AGENT_WORKSPACE_ROOT;
  process.env.AGENT_WORKSPACE_ROOT = workspaceRoot;

  try {
    return callback();
  } finally {
    if (previousRoot === undefined) {
      delete process.env.AGENT_WORKSPACE_ROOT;
    } else {
      process.env.AGENT_WORKSPACE_ROOT = previousRoot;
    }
  }
}

test("safe_command allows the MVP command allowlist", () => {
  withWorkspaceRoot(process.cwd(), () => {
    assert.equal(buildAllowedCommandCall("git", ["status"]).ok, true);
    assert.equal(buildAllowedCommandCall("rg", ["--files"]).ok, true);
    assert.equal(buildAllowedCommandCall("rg", ["safe_command", "src"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["run", "build"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["run", "lint"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["test"]).ok, true);
  });
});

test("safe_command detects pnpm and yarn lockfiles", () => {
  const scripts = packageJson({
    build: "echo build",
    lint: "echo lint",
    test: "echo test",
  });

  withWorkspaceRoot(createWorkspace({ "package.json": scripts, "pnpm-lock.yaml": "" }), () => {
    assert.equal(buildAllowedCommandCall("pnpm", ["build"]).ok, true);
    assert.equal(buildAllowedCommandCall("pnpm", ["test"]).ok, true);
    assert.equal(buildAllowedCommandCall("pnpm", ["lint"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["run", "build"]).ok, false);
  });

  withWorkspaceRoot(createWorkspace({ "package.json": scripts, "yarn.lock": "" }), () => {
    assert.equal(buildAllowedCommandCall("yarn", ["build"]).ok, true);
    assert.equal(buildAllowedCommandCall("yarn", ["test"]).ok, true);
    assert.equal(buildAllowedCommandCall("yarn", ["lint"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["run", "build"]).ok, false);
  });
});

test("safe_command defaults JavaScript workspaces without lockfiles to npm", () => {
  const workspaceRoot = createWorkspace({
    "package.json": packageJson({
      build: "echo build",
      lint: "echo lint",
      test: "echo test",
    }),
  });

  withWorkspaceRoot(workspaceRoot, () => {
    assert.equal(buildAllowedCommandCall("npm", ["run", "build"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["test"]).ok, true);
    assert.equal(buildAllowedCommandCall("npm", ["run", "lint"]).ok, true);
    assert.equal(buildAllowedCommandCall("pnpm", ["build"]).ok, false);
  });
});

test("safe_command rejects package scripts missing from package.json", () => {
  const workspaceRoot = createWorkspace({
    "package.json": packageJson({ test: "node --test" }),
  });

  withWorkspaceRoot(workspaceRoot, () => {
    const buildResult = buildAllowedCommandCall("npm", ["run", "build"]);
    const lintResult = buildAllowedCommandCall("npm", ["run", "lint"]);

    assert.equal(buildResult.ok, false);
    assert.match(buildResult.message, /did not find a "build" script/);
    assert.equal(lintResult.ok, false);
    assert.match(lintResult.message, /did not find a "lint" script/);
  });
});

test("safe_command allows cargo build, test, and clippy in Rust workspaces", () => {
  const workspaceRoot = createWorkspace({ "Cargo.toml": "[package]\nname = \"demo\"\n" });

  withWorkspaceRoot(workspaceRoot, () => {
    assert.equal(buildAllowedCommandCall("cargo", ["build"]).ok, true);
    assert.equal(buildAllowedCommandCall("cargo", ["test"]).ok, true);
    assert.equal(buildAllowedCommandCall("cargo", ["clippy"]).ok, true);
    assert.equal(buildAllowedCommandCall("cargo", ["run"]).ok, false);
  });
});

test("safe_command allows pytest and ruff in Python workspaces", () => {
  withWorkspaceRoot(createWorkspace({ "pyproject.toml": "[project]\nname = \"demo\"\n" }), () => {
    assert.equal(buildAllowedCommandCall("pytest", []).ok, true);
    assert.equal(buildAllowedCommandCall("ruff", ["check"]).ok, true);
    assert.equal(buildAllowedCommandCall("ruff", ["format"]).ok, true);
    assert.equal(buildAllowedCommandCall("ruff", ["check", "."]).ok, false);
  });

  withWorkspaceRoot(createWorkspace({ "setup.py": "from setuptools import setup\n" }), () => {
    assert.equal(buildAllowedCommandCall("pytest", []).ok, true);
    assert.equal(buildAllowedCommandCall("ruff", ["check"]).ok, true);
  });
});

test("safe_command allows make build, test, and lint when Makefile exists", () => {
  const workspaceRoot = createWorkspace({ Makefile: "build:\n\ttest -n build\n" });

  withWorkspaceRoot(workspaceRoot, () => {
    assert.equal(buildAllowedCommandCall("make", ["build"]).ok, true);
    assert.equal(buildAllowedCommandCall("make", ["test"]).ok, true);
    assert.equal(buildAllowedCommandCall("make", ["lint"]).ok, true);
    assert.equal(buildAllowedCommandCall("make", ["install"]).ok, false);
  });
});

test("safe_command rejects commands outside the allowlist", async () => {
  const blockedPowerShell = await safeCommandTool.execute({
    command: "powershell",
    args: ["Get-ChildItem"],
  });
  const unknownCommand = await safeCommandTool.execute({
    command: "ls",
    args: [],
  });
  const blockedPython = await safeCommandTool.execute({
    command: "python",
    args: ["-m", "pytest"],
  });
  const blockedNode = await safeCommandTool.execute({
    command: "node",
    args: ["script.js"],
  });
  const blockedBash = await safeCommandTool.execute({
    command: "bash",
    args: ["-lc", "echo unsafe"],
  });
  const customRgFlag = buildAllowedCommandCall("rg", ["--hidden"]);
  const unsupportedNpmScript = buildAllowedCommandCall("npm", ["run", "dev"]);

  assert.equal(blockedPowerShell.ok, false);
  assert.match(blockedPowerShell.content, /blocked for safety/);
  assert.equal(unknownCommand.ok, false);
  assert.match(unknownCommand.content, /not in the safe_command allowlist/);
  assert.equal(blockedPython.ok, false);
  assert.match(blockedPython.content, /blocked for safety/);
  assert.equal(blockedNode.ok, false);
  assert.match(blockedNode.content, /blocked for safety/);
  assert.equal(blockedBash.ok, false);
  assert.match(blockedBash.content, /blocked for safety/);
  assert.equal(customRgFlag.ok, false);
  assert.equal(unsupportedNpmScript.ok, false);
});
