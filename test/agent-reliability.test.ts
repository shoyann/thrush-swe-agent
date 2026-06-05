import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySafeCommandIntent,
  extractRequiredValidations,
  isFileModificationRequest,
  looksLikeManualEditInstructions,
  parseSessionSettingCommand,
} from "../src/lib/agent/intent";
import {
  createRunLedger,
  getMissingRequiredValidations,
  recordLedgerToolRun,
} from "../src/lib/agent/run-ledger";
import type { ToolRun } from "../src/lib/agent/tool-run-types";

function toolRun(partial: Partial<ToolRun>): ToolRun {
  return {
    assistantMessage: {
      role: "assistant",
      content: null,
    },
    input: {},
    inputText: "{}",
    name: "read_file",
    result: {
      ok: true,
      content: "ok",
    },
    tool: {
      name: "read_file",
      description: "",
      inputSchema: {
        type: "object",
        properties: {},
      },
      async execute() {
        return {
          ok: true,
          content: "ok",
        };
      },
    },
    toolCallId: "tool-call-1",
    ...partial,
  };
}

test("Chinese edit and manual-instruction intent is detected", () => {
  assert.equal(isFileModificationRequest("请修好这些测试失败"), true);
  assert.equal(isFileModificationRequest("应用修复并运行 npm test"), true);
  assert.equal(isFileModificationRequest("你倒是修啊！！！"), true);
  assert.equal(looksLikeManualEditInstructions("请手动把 a 改成 b"), true);
});

test("autoApprove text commands parse as real setting commands", () => {
  assert.deepEqual(parseSessionSettingCommand("autoApprove: true"), {
    autoApprove: true,
    kind: "autoApprove",
  });
  assert.deepEqual(parseSessionSettingCommand("打开全自动模式"), {
    autoApprove: true,
    kind: "autoApprove",
  });
  assert.deepEqual(parseSessionSettingCommand("关闭自动批准"), {
    autoApprove: false,
    kind: "autoApprove",
  });
});

test("required npm validations are extracted from mixed-language tasks", () => {
  const validations = extractRequiredValidations(
    "修完后运行 npm test、npm run build、npm run lint，全部通过才算完成",
  );

  assert.deepEqual(
    validations.map((validation) => validation.label),
    ["npm test", "npm run build", "npm run lint"],
  );
});

test("failing tests before edits are diagnostic, after edits are validation", () => {
  const input = {
    command: "npm",
    args: ["test"],
  };

  assert.equal(
    classifySafeCommandIntent(input, "fix failing tests", false),
    "diagnostic",
  );
  assert.equal(
    classifySafeCommandIntent(input, "fix failing tests", true),
    "validation",
  );
});

test("run ledger satisfies required validations only with matching successful commands", () => {
  const ledger = createRunLedger("run npm test and npm run build");

  recordLedgerToolRun(
    ledger,
    "run npm test and npm run build",
    toolRun({
      input: {
        command: "npm",
        args: ["test"],
      },
      inputText: '{"command":"npm","args":["test"]}',
      name: "safe_command",
      result: {
        ok: true,
        content: "passed",
      },
      toolCallId: "test-run",
    }),
  );

  assert.deepEqual(
    getMissingRequiredValidations(ledger).map((validation) => validation.label),
    ["npm run build"],
  );
});
