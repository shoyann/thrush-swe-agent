import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveMiniCommand } from "../src/lib/auto/mini-resolver";
import { getMiniRuntimeStatus } from "../src/lib/auto/mini-runtime";

function withCwd<T>(cwd: string, run: () => T): T {
  const previous = process.cwd();

  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

function createTempProject() {
  const root = mkdtempSync(path.join(os.tmpdir(), "thrush-mini-"));

  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "vendor", "mini-swe-agent"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "mini-auto-run.py"), "#!/usr/bin/env python3\n");
  writeFileSync(path.join(root, "scripts", "mini-runtime-requirements.txt"), "openai\nlitellm\n");

  return root;
}

function writeReadyRuntime(root: string) {
  const pythonPath = path.join(root, "data", "mini-venv", "bin", "python");
  const readyPath = path.join(root, "data", "mini-venv", ".ready.json");
  const requirementsText = "openai\nlitellm\n";
  const requirementsSha256 = createHash("sha256")
    .update(requirementsText)
    .digest("hex");

  mkdirSync(path.dirname(pythonPath), { recursive: true });
  writeFileSync(
    pythonPath,
    [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ]; then echo 'Python 3.12.0'; exit 0; fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(pythonPath, 0o755);
  writeFileSync(
    readyPath,
    `${JSON.stringify({ requirementsSha256 })}\n`,
  );
}

test("bundled runtime uses the prepared venv python and non-interactive wrapper", () => {
  const root = createTempProject();
  writeReadyRuntime(root);

  try {
    withCwd(root, () => {
      const runtime = getMiniRuntimeStatus();
      const command = resolveMiniCommand();

      assert.equal(runtime.ready, true);
      assert.equal(command.source, "bundled");
      assert.equal(command.command, path.join(root, "data", "mini-venv", "bin", "python"));
      assert.deepEqual(command.argsPrefix, [path.join(root, "scripts", "mini-auto-run.py")]);
      assert.equal(command.argsPrefix.includes("--with"), false);
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("missing bundled runtime falls back without uv run --with dependency installs", () => {
  const root = createTempProject();

  try {
    withCwd(root, () => {
      const runtime = getMiniRuntimeStatus();
      const command = resolveMiniCommand();

      assert.equal(runtime.ready, false);
      assert.equal(command.source, "uvx");
      assert.equal(command.command, "uvx");
      assert.deepEqual(command.argsPrefix, ["mini-swe-agent"]);
      assert.equal(command.argsPrefix.includes("--with"), false);
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
