import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getMiniFailure,
  parseMiniExitStatus,
} from "../src/lib/auto/mini-status";

test("parseMiniExitStatus reads mini trajectory exit status", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "thrush-mini-status-"));
  const trajectoryPath = path.join(workspace, "trajectory.json");

  try {
    writeFileSync(
      trajectoryPath,
      JSON.stringify({ info: { exit_status: "Submitted" } }),
    );

    assert.equal(parseMiniExitStatus(trajectoryPath), "Submitted");
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
});

test("getMiniFailure maps limits, timeout, and format failures", () => {
  assert.equal(
    getMiniFailure({
      exitCode: 1,
      logText: "",
      miniExitStatus: "LimitsExceeded",
    }).category,
    "cost_limit",
  );
  assert.equal(
    getMiniFailure({
      exitCode: 1,
      logText: "",
      miniExitStatus: "TimeExceeded",
    }).category,
    "timeout",
  );
  assert.equal(
    getMiniFailure({
      exitCode: 1,
      logText: "",
      miniExitStatus: "RepeatedFormatError",
    }).category,
    "repeated_format_error",
  );
});

test("getMiniFailure detects Docker startup problems from mini logs", () => {
  const failure = getMiniFailure({
    exitCode: 1,
    logText: "Cannot connect to the Docker daemon",
    miniExitStatus: "Unknown",
  });

  assert.equal(failure.category, "docker_start_failed");
  assert.match(failure.message, /Docker/);
});

test("getMiniFailure detects dependency download timeouts from uv logs", () => {
  const failure = getMiniFailure({
    exitCode: 1,
    logText:
      "Failed to download distribution due to network timeout. Try increasing UV_HTTP_TIMEOUT",
    miniExitStatus: "Unknown",
  });

  assert.equal(failure.category, "dependency_install_failed");
  assert.match(failure.message, /package download timed out/);
});
