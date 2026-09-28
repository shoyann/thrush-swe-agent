import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createAgentRunner } from "../src/lib/agent/run-agent";
import type { ThoughtResult } from "../src/lib/agent/agent-thinking";
import type { AgentSessionContext } from "../src/types/agent";
import type { ToolCallArgs } from "../src/lib/tools/types";
import { normalizeWorkflow, newWorkflow } from "../src/lib/agent/workflow";
import { MAX_TOOL_CALLS } from "../src/lib/agent/tool-run-types";

type Decision = [string, ToolCallArgs];
const plan: Decision = [
  "task_plan",
  {
    kind: "change",
    steps: ["Fix implementation", "Add regression coverage", "Run checks"],
    checks: ["npm test"],
    verification_note: "",
  },
];
const verify: Decision = ["safe_command", { command: "npm", args: ["test"] }];
const finish: Decision = [
  "finish_task",
  { status: "completed", message: "修复完成，测试通过。" },
];
const write = (file: string, content: string): Decision => [
  "write_file",
  { path: file, content },
];
const read = (file: string): Decision => ["read_file", { path: file }];
const script =
  'const assert=require("node:assert/strict");assert.equal(require("./value.cjs"),2);';

function runner(decisions: Decision[], seen: string[] = []) {
  return createAgentRunner({
    getConfiguredModelName: () => "test-model",
    prepareConversationContext: async (
      _model,
      _messages,
      _task,
      sessionContext,
    ) => ({ recentConversation: [], sessionContext }),
    think: async (context, _perception, runs): Promise<ThoughtResult> => {
      seen.push(context.cleanTask);
      const decision = decisions.shift();
      assert.ok(
        decision,
        `Unexpected planning round after: ${runs.at(-1)?.result.content}`,
      );
      return {
        assistantMessage: null,
        directAnswer: null,
        nextAction: "",
        plan: [],
        step: {
          id: `think-${runs.length}`,
          title: "Think",
          detail: decision[0],
          status: "done",
        },
        toolCallId: null,
        toolName: decision[0],
        toolInput: decision[1],
      };
    },
  });
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "thrush-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "node check.cjs" } }),
  );
  await writeFile(path.join(dir, "value.cjs"), "module.exports=1;");
  await writeFile(path.join(dir, "check.cjs"), script);
  return dir;
}

test("failed test leads to actual edits and a successful retest in one turn", async (t) => {
  const dir = await fixture(t);
  const results: boolean[] = [];
  const run = runner([
    plan,
    verify,
    read("value.cjs"),
    write("value.cjs", "module.exports=2;"),
    verify,
    finish,
  ]);
  const result = await run(
    "修复代码并运行测试",
    [],
    { autoApprove: true },
    "r",
    {
      workspaceRoot: dir,
      onToolRun: (r) => {
        if (r.name === "safe_command") results.push(r.result.ok);
      },
    },
  );
  assert.equal(result.sessionContext.workflow?.status, "completed");
  assert.deepEqual(results, [false, true]);
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "module.exports=2;",
  );
});

test("successful baseline tests cannot finish a change task with no edits", async (t) => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, "value.cjs"), "module.exports=2;");
  const rejected: string[] = [];
  const result = await runner([
    plan,
    verify,
    finish,
    write("value.cjs", "module.exports=2; // fixed"),
    verify,
    finish,
  ])("fix and test", [], { autoApprove: true }, "r", {
    workspaceRoot: dir,
    onToolRun: (r) => {
      if (!r.result.ok) rejected.push(r.result.content);
    },
  });
  assert.equal(result.sessionContext.workflow?.status, "completed");
  assert.match(rejected.join("\n"), /no file changes/);
});

test("later edits invalidate passing tests and require retest", async (t) => {
  const dir = await fixture(t);
  const rejected: string[] = [];
  const result = await runner([
    plan,
    write("value.cjs", "module.exports=2;"),
    verify,
    write("notes.txt", "Second file"),
    finish,
    verify,
    finish,
  ])("fix both files", [], { autoApprove: true }, "r", {
    workspaceRoot: dir,
    onToolRun: (r) => {
      if (!r.result.ok) rejected.push(r.result.content);
    },
  });
  assert.equal(result.sessionContext.workflow?.status, "completed");
  assert.deepEqual(result.sessionContext.workflow?.changedFiles, [
    "value.cjs",
    "notes.txt",
  ]);
  assert.match(rejected.join("\n"), /latest edit/);
});

test("manual approval restores original objective and continues to verification", async (t) => {
  const dir = await fixture(t);
  const first = await runner([
    plan,
    read("value.cjs"),
    write("value.cjs", "module.exports=2;"),
  ])("修复零值并测试", [], {}, "r", { workspaceRoot: dir });
  assert.equal(first.sessionContext.workflow?.status, "awaiting_approval");
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "module.exports=1;",
  );
  const seen: string[] = [];
  const resumed = await runner([verify, finish], seen)(
    `APPROVE_WRITE ${first.sessionContext.pendingDraft!.id}`,
    [],
    JSON.parse(JSON.stringify(first.sessionContext)),
    "r2",
    { workspaceRoot: dir },
  );
  assert.equal(resumed.sessionContext.workflow?.status, "completed");
  assert.deepEqual(seen, ["修复零值并测试", "修复零值并测试"]);
});

test("Chinese continue with 测试 preserves task across serialization and budget pause", async (t) => {
  const dir = await fixture(t);
  const decisions: Decision[] = [
    plan,
    ...Array.from({ length: MAX_TOOL_CALLS - 1 }, () => read("value.cjs")),
  ];
  let checkpoint: AgentSessionContext = {};
  const first = await runner(decisions)(
    "修复原来的完整任务",
    [],
    { autoApprove: true },
    "r",
    {
      workspaceRoot: dir,
      onCheckpoint: (c) => {
        checkpoint = c;
      },
    },
  );
  assert.equal(first.sessionContext.workflow?.status, "paused");
  const seen: string[] = [];
  const resumed = await runner(
    [write("value.cjs", "module.exports=2;"), verify, finish],
    seen,
  )(
    "请继续完成刚才的完整修复任务，并运行测试",
    [],
    JSON.parse(JSON.stringify(checkpoint)),
    "r2",
    { workspaceRoot: dir },
  );
  assert.equal(resumed.sessionContext.workflow?.status, "completed");
  assert.ok(seen.every((goal) => goal === "修复原来的完整任务"));
});

test("read-only and continue never silently approve a pending draft", async (t) => {
  const dir = await fixture(t);
  const first = await runner([plan, write("value.cjs", "module.exports=2;")])(
    "fix",
    [],
    {},
    "r",
    { workspaceRoot: dir },
  );
  const waiting = await runner([])(
    "请继续测试",
    [],
    first.sessionContext,
    "r2",
    { workspaceRoot: dir },
  );
  assert.equal(waiting.sessionContext.workflow?.status, "awaiting_approval");
  const blocked = await runner([])(
    "批准",
    [],
    { ...first.sessionContext, readOnly: true },
    "r3",
    { workspaceRoot: dir },
  );
  assert.notEqual(blocked.sessionContext.workflow?.status, "completed");
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "module.exports=1;",
  );
});

test("stale approvals preserve newer user edits", async (t) => {
  const dir = await fixture(t);
  const first = await runner([plan, write("value.cjs", "module.exports=2;")])(
    "fix",
    [],
    {},
    "r",
    { workspaceRoot: dir },
  );
  await writeFile(path.join(dir, "value.cjs"), "user changed this");
  const next = await runner([])("批准", [], first.sessionContext, "r2", {
    workspaceRoot: dir,
  });
  assert.match(next.message.content, /File changed/);
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "user changed this",
  );
});

test("repeated failed reads stop with a saved task rather than loop forever", async (t) => {
  const dir = await fixture(t);
  const next = await runner([
    plan,
    read("missing"),
    read("missing"),
    read("missing"),
  ])("fix", [], {}, "r", { workspaceRoot: dir });
  assert.equal(next.sessionContext.workflow?.status, "blocked");
  assert.equal(next.sessionContext.lastReadFilePath, null);
});

test("workspace mismatch blocks resumed writes", async (t) => {
  const dir = await fixture(t);
  const state = newWorkflow("fix", "other-directory");
  const next = await runner([])("继续", [], { workflow: state }, "r", {
    workspaceRoot: dir,
  });
  assert.equal(next.sessionContext.workflow?.status, "blocked");
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "module.exports=1;",
  );
});

test("cancellation preserves a resumable task and does not run another operation", async (t) => {
  const dir = await fixture(t);
  const abort = new AbortController();
  const next = await runner([plan, write("value.cjs", "module.exports=2;")])(
    "fix",
    [],
    { autoApprove: true },
    "r",
    {
      workspaceRoot: dir,
      signal: abort.signal,
      onToolRun: () => abort.abort(),
    },
  );
  assert.equal(next.sessionContext.workflow?.status, "paused");
  assert.equal(
    await readFile(path.join(dir, "value.cjs"), "utf8"),
    "module.exports=1;",
  );
});

test("a plan cannot drop required checks to bypass completion", async (t) => {
  const dir = await fixture(t);
  const next = await runner([
    plan,
    ["task_plan", { ...plan[1], checks: [], verification_note: "skip" }],
    write("value.cjs", "module.exports=2;"),
    finish,
    verify,
    finish,
  ])("fix", [], { autoApprove: true }, "r", { workspaceRoot: dir });
  assert.equal(next.sessionContext.workflow?.status, "completed");
  assert.deepEqual(next.sessionContext.workflow?.plan?.checks, ["npm test"]);
});

test("versioned task state rejects unknown or malformed persisted values", () => {
  assert.equal(normalizeWorkflow({ version: 2 }), null);
  assert.equal(
    normalizeWorkflow({ ...newWorkflow("fix", "."), plan: { steps: null } }),
    null,
  );
  const state = newWorkflow("fix", ".");
  assert.deepEqual(normalizeWorkflow(JSON.parse(JSON.stringify(state))), state);
});

test("identical-content drafts do not count as implementation changes", async (t) => {
  const dir = await fixture(t);
  const next = await runner([
    plan,
    write("value.cjs", "module.exports=1;"),
    finish,
    [
      "finish_task",
      { status: "blocked", message: "No implementation change yet." },
    ],
  ])("fix", [], { autoApprove: true }, "r", { workspaceRoot: dir });
  assert.equal(next.sessionContext.workflow?.status, "blocked");
  assert.deepEqual(next.sessionContext.workflow?.changedFiles, []);
});

test("interrupted writes recover idempotently without overwriting new content", async (t) => {
  const dir = await fixture(t);
  const first = await runner([plan, write("value.cjs", "module.exports=2;")])(
    "fix",
    [],
    {},
    "r",
    { workspaceRoot: dir },
  );
  // Simulate disk write succeeding immediately before the process died.
  await writeFile(
    path.join(dir, "value.cjs"),
    first.sessionContext.pendingDraft!.content,
  );
  first.sessionContext.workflow!.inFlight = "Apply approved draft";
  const next = await runner([verify, finish])(
    "APPROVE_WRITE " + first.sessionContext.pendingDraft!.id,
    [],
    first.sessionContext,
    "r2",
    { workspaceRoot: dir },
  );
  assert.equal(next.sessionContext.workflow?.status, "completed");
  assert.deepEqual(next.sessionContext.workflow?.changedFiles, ["value.cjs"]);
});

test("legacy chat continuation migrates the actual request, never just the last tool", async (t) => {
  const dir = await fixture(t);
  const seen: string[] = [];
  const next = await runner(
    [plan, write("value.cjs", "module.exports=2;"), verify, finish],
    seen,
  )(
    "请继续完成修复并测试",
    [
      { id: "old-user", role: "user", content: "修复原始缺陷并添加测试" },
      {
        id: "old-answer",
        role: "assistant",
        content: "npm test passed. Next I will fix it.",
      },
    ],
    {
      autoApprove: true,
      lastToolName: "safe_command",
      lastToolInput: "npm test",
    },
    "r",
    { workspaceRoot: dir },
  );
  assert.equal(next.sessionContext.workflow?.status, "completed");
  assert.ok(seen.every((goal) => goal === "修复原始缺陷并添加测试"));
});

test("real checks join an initially empty plan and are reported as verified", async (t) => {
  const dir = await fixture(t);
  const next = await runner([
    [
      "task_plan",
      { ...plan[1], checks: [], verification_note: "Discover scripts first" },
    ],
    write("value.cjs", "module.exports=2;"),
    verify,
    finish,
  ])("fix", [], { autoApprove: true }, "r", { workspaceRoot: dir });
  assert.equal(next.sessionContext.workflow?.status, "completed");
  assert.deepEqual(next.sessionContext.workflow?.plan?.checks, ["npm test"]);
  assert.doesNotMatch(next.message.content, /未运行自动验收/);
});

test("unverified changes cannot claim completion and remain resumable", async (t) => {
  const dir = await fixture(t);
  const rejected: string[] = [];
  const next = await runner([
    [
      "task_plan",
      { ...plan[1], checks: [], verification_note: "No check yet" },
    ],
    write("value.cjs", "module.exports=2;"),
    finish,
    [
      "finish_task",
      {
        status: "unverified",
        message: "Changes saved, tests still need to run.",
      },
    ],
  ])("fix", [], { autoApprove: true }, "r", {
    workspaceRoot: dir,
    onToolRun: (r) => {
      if (!r.result.ok) rejected.push(r.result.content);
    },
  });
  assert.equal(next.sessionContext.workflow?.status, "unverified");
  assert.match(rejected.join("\n"), /No verification/);
  const resumed = await runner([verify, finish])(
    "继续",
    [],
    next.sessionContext,
    "r2",
    { workspaceRoot: dir },
  );
  assert.equal(resumed.sessionContext.workflow?.status, "completed");
});
