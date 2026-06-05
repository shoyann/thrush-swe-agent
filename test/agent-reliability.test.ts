import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySafeCommandIntent,
  extractRequiredValidations,
  getDirectSafeCommandIntent,
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
  assert.equal(isFileModificationRequest("\u8bf7\u4fee\u597d\u8fd9\u4e9b\u6d4b\u8bd5\u5931\u8d25"), true);
  assert.equal(isFileModificationRequest("\u5e94\u7528\u4fee\u590d\u5e76\u8fd0\u884c npm test"), true);
  assert.equal(isFileModificationRequest("\u4f60\u5012\u662f\u4fee\u554a\uff01\uff01\uff01"), true);
  assert.equal(looksLikeManualEditInstructions("\u8bf7\u624b\u52a8\u628a a \u6539\u6210 b"), true);
});

test("autoApprove text commands parse as real setting commands", () => {
  assert.deepEqual(parseSessionSettingCommand("autoApprove: true"), {
    autoApprove: true,
    kind: "autoApprove",
  });
  assert.deepEqual(parseSessionSettingCommand("\u6253\u5f00\u5168\u81ea\u52a8\u6a21\u5f0f"), {
    autoApprove: true,
    kind: "autoApprove",
  });
  assert.deepEqual(parseSessionSettingCommand("\u5173\u95ed\u81ea\u52a8\u6279\u51c6"), {
    autoApprove: false,
    kind: "autoApprove",
  });
});

test("required npm validations are extracted from mixed-language tasks", () => {
  const validations = extractRequiredValidations(
    "\u4fee\u5b8c\u540e\u8fd0\u884c npm test\u3001npm run build\u3001npm run lint\uff0c\u5168\u90e8\u901a\u8fc7\u624d\u7b97\u5b8c\u6210",
  );

  assert.deepEqual(
    validations.map((validation) => validation.label),
    ["npm test", "npm run build", "npm run lint"],
  );
});

test("direct safe command intent requires explicit run/check wording", () => {
  assert.deepEqual(getDirectSafeCommandIntent("\u8dd1\u4e00\u6b21 npm test"), {
    command: "npm",
    args: ["test"],
    label: "npm test",
  });
  assert.deepEqual(getDirectSafeCommandIntent("\u68c0\u67e5\u80fd\u4e0d\u80fd\u6784\u5efa"), {
    command: "npm",
    args: ["run", "build"],
    label: "npm run build",
  });
  assert.equal(getDirectSafeCommandIntent("build a settings page"), null);
  assert.equal(getDirectSafeCommandIntent("write tests for settings"), null);
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

test("new write invalidates earlier successful validations", () => {
  const ledger = createRunLedger("run npm test");

  recordLedgerToolRun(
    ledger,
    "run npm test",
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
  assert.equal(getMissingRequiredValidations(ledger).length, 0);

  recordLedgerToolRun(
    ledger,
    "run npm test",
    toolRun({
      name: "replace_text",
      result: {
        ok: true,
        content: "drafted",
        draft: {
          content: "next",
          id: "draft-1",
          kind: "write_file",
          path: "src/example.ts",
        },
      },
      toolCallId: "write-run",
    }),
  );

  assert.deepEqual(
    getMissingRequiredValidations(ledger).map((validation) => validation.label),
    ["npm test"],
  );
});
