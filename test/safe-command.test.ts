import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { __safeCommandTestInternals, safeCommandTool } from "../src/lib/tools/safe-command";

const { buildAllowedCommandCall } = __safeCommandTestInternals;

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

test("safe_command rejects npm run lint when the workspace has no lint script", () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "thrush-safe-command-"));
  writeFileSync(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );

  withWorkspaceRoot(workspaceRoot, () => {
    const result = buildAllowedCommandCall("npm", ["run", "lint"]);

    assert.equal(result.ok, false);
    assert.match(result.message, /did not find a "lint" script/);
  });
});

test("safe_command rejects commands outside the allowlist", async () => {
  const blockedShell = await safeCommandTool.execute({
    command: "powershell",
    args: ["Get-ChildItem"],
  });
  const unknownCommand = await safeCommandTool.execute({
    command: "ls",
    args: [],
  });
  const customRgFlag = buildAllowedCommandCall("rg", ["--hidden"]);
  const unsupportedNpmScript = buildAllowedCommandCall("npm", ["run", "dev"]);

  assert.equal(blockedShell.ok, false);
  assert.match(blockedShell.content, /blocked for safety/);
  assert.equal(unknownCommand.ok, false);
  assert.match(unknownCommand.content, /not in the safe_command allowlist/);
  assert.equal(customRgFlag.ok, false);
  assert.equal(unsupportedNpmScript.ok, false);
});
