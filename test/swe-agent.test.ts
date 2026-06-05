import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __sweAgentTestInternals,
  sweAgentTool,
} from "../src/lib/tools/swe-agent";

const {
  buildSweAgentCommand,
  deriveGithubRepoUrl,
  normalizeGithubIssueUrl,
  parseSweAgentInput,
} = __sweAgentTestInternals;

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

test("swe_agent derives repository URLs from GitHub issue URLs", () => {
  assert.equal(
    deriveGithubRepoUrl("https://github.com/SWE-agent/test-repo/issues/1"),
    "https://github.com/SWE-agent/test-repo",
  );
  assert.deepEqual(
    normalizeGithubIssueUrl("https://github.com/SWE-agent/test-repo/issues/1/"),
    {
      issueUrl: "https://github.com/SWE-agent/test-repo/issues/1",
      repoUrl: "https://github.com/SWE-agent/test-repo",
    },
  );
  assert.equal(deriveGithubRepoUrl("https://example.com/not-github/issues/1"), null);
});

test("swe_agent parses GitHub issue input and builds a safe command preview", () => {
  const parsed = parseSweAgentInput({
    action: "plan",
    github_issue_url: "https://github.com/SWE-agent/test-repo/issues/1",
    model_name: "gpt-4o",
    cost_limit: 2,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }

  const plan = buildSweAgentCommand(parsed);

  assert.equal(plan.command, "sweagent");
  assert.deepEqual(plan.args, [
    "run",
    "--agent.model.name=gpt-4o",
    `--output_dir=${path.resolve(process.cwd(), "data", "swe-agent-runs")}`,
    "--agent.model.per_instance_cost_limit=2",
    "--env.repo.github_url=https://github.com/SWE-agent/test-repo",
    "--problem_statement.github_url=https://github.com/SWE-agent/test-repo/issues/1",
  ]);
});

test("swe_agent builds local workspace command previews without running by default", async () => {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "thrush-swe-agent-tool-"));

  await withWorkspaceRoot(workspaceRoot, async () => {
    const result = await sweAgentTool.execute({
      action: "plan",
      problem_statement: "Fix the failing tests.",
      model_name: "claude-sonnet-4-20250514",
    });

    assert.equal(result.ok, true);
    assert.match(result.content, /status: plan/);
    assert.match(result.content, /--env\.repo\.path=/);
    assert.match(result.content, /--problem_statement\.path=/);
    assert.match(result.content, /SWE_AGENT_TOOL_ENABLED=true/);
  });
});

test("swe_agent rejects ambiguous problem sources", () => {
  const parsed = parseSweAgentInput({
    action: "plan",
    github_issue_url: "https://github.com/SWE-agent/test-repo/issues/1",
    problem_statement: "Fix this locally too.",
  });

  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.message, /not both/);
  }
});

test("swe_agent blocks real runs unless explicitly enabled", async () => {
  const previousEnabled = process.env.SWE_AGENT_TOOL_ENABLED;
  delete process.env.SWE_AGENT_TOOL_ENABLED;

  try {
    const result = await sweAgentTool.execute({
      action: "run",
      github_issue_url: "https://github.com/SWE-agent/test-repo/issues/1",
      model_name: "gpt-4o",
    });

    assert.equal(result.ok, false);
    assert.match(result.content, /disabled by default/);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.SWE_AGENT_TOOL_ENABLED;
    } else {
      process.env.SWE_AGENT_TOOL_ENABLED = previousEnabled;
    }
  }
});
