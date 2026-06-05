import {
  getStringArg,
  getStringArrayArg,
} from "./tool-args";
import type { ToolExecutionInput } from "@/lib/tools/types";

export type CommandIntent = "diagnostic" | "validation" | "build_check" | "lint_check";

export type RequiredValidation = {
  id: string;
  command: string;
  args: string[];
  label: string;
  satisfiedByToolCallId?: string;
  satisfiedAt?: number;
  lastFailure?: string;
};

export type SessionSettingCommand =
  | {
      autoApprove: boolean;
      kind: "autoApprove";
    }
  | null;

export function isFileModificationRequest(task: string) {
  return (
    /(modify|edit|update|change|append|replace|rewrite|revise|write|create|overwrite|delete|remove|fix|repair|apply|implement)/i.test(task) ||
    /(修改|编辑|更新|改动|更改|追加|替换|重写|删除|增加|修复|修好|应用修复|实现|写入|改一下|改好|你倒是修)/u.test(task)
  );
}

export function looksLikeManualEditInstructions(text: string) {
  return (
    /(manually|by hand|copy this|paste this|you should edit|change .* to |replace .* with )/i.test(text) ||
    /(手动|自己修改|你需要修改|把.+改成|替换为|请在.+里改)/u.test(text)
  );
}

export function parseSessionSettingCommand(task: string): SessionSettingCommand {
  const cleanTask = task.trim();

  if (
    /^(?:auto\s*approve|autoApprove)\s*[:=]?\s*(?:true|on|yes|enable|enabled)$/i.test(cleanTask) ||
    /^(?:打开|开启|启用).{0,8}(?:auto\s*approve|autoApprove|全自动|自动批准|自动应用)/u.test(cleanTask)
  ) {
    return {
      autoApprove: true,
      kind: "autoApprove",
    };
  }

  if (
    /^(?:auto\s*approve|autoApprove)\s*[:=]?\s*(?:false|off|no|disable|disabled)$/i.test(cleanTask) ||
    /^(?:关闭|禁用).{0,8}(?:auto\s*approve|autoApprove|全自动|自动批准|自动应用)/u.test(cleanTask)
  ) {
    return {
      autoApprove: false,
      kind: "autoApprove",
    };
  }

  return null;
}

function createValidation(command: string, args: string[], label: string): RequiredValidation {
  return {
    id: `validation:${command}:${args.join(" ")}`,
    command,
    args,
    label,
  };
}

function dedupeValidations(validations: RequiredValidation[]) {
  const seen = new Set<string>();
  return validations.filter((validation) => {
    const key = `${validation.command}\0${validation.args.join("\0")}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function extractRequiredValidations(task: string) {
  const validations: RequiredValidation[] = [];

  if (/\bnpm\s+(?:run\s+)?test\b/i.test(task) || /(?:运行|跑|执行).{0,8}(?:npm\s+test|npm\s+run\s+test|测试)/u.test(task)) {
    validations.push(createValidation("npm", ["test"], "npm test"));
  }

  if (/\bnpm\s+run\s+build\b/i.test(task) || /(?:运行|跑|执行).{0,8}(?:npm\s+run\s+build|构建|编译)/u.test(task)) {
    validations.push(createValidation("npm", ["run", "build"], "npm run build"));
  }

  if (/\bnpm\s+run\s+lint\b/i.test(task) || /(?:运行|跑|执行).{0,8}(?:npm\s+run\s+lint|lint|代码检查)/iu.test(task)) {
    validations.push(createValidation("npm", ["run", "lint"], "npm run lint"));
  }

  return dedupeValidations(validations);
}

export function getSafeCommandParts(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return null;
  }

  const command = getStringArg(input, "command").toLowerCase();
  const args = getStringArrayArg(input, "args");

  return command ? { command, args } : null;
}

export function isSameCommand(
  left: { command: string; args: string[] },
  right: { command: string; args: string[] },
) {
  return (
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

export function classifySafeCommandIntent(
  input: ToolExecutionInput,
  task: string,
  hasAppliedOrDraftedWrite: boolean,
): CommandIntent {
  const command = getSafeCommandParts(input);

  if (!command) {
    return "diagnostic";
  }

  if (
    command.command === "npm" &&
    command.args[0] === "run" &&
    command.args[1] === "build"
  ) {
    return "build_check";
  }

  if (
    command.command === "npm" &&
    command.args[0] === "run" &&
    command.args[1] === "lint"
  ) {
    return "lint_check";
  }

  if (
    (command.command === "npm" && command.args[0] === "test") ||
    (command.command === "npm" && command.args[0] === "run" && command.args[1] === "test")
  ) {
    return hasAppliedOrDraftedWrite || !/(fix|repair|failing|失败|修复|修好)/iu.test(task)
      ? "validation"
      : "diagnostic";
  }

  return hasAppliedOrDraftedWrite ? "validation" : "diagnostic";
}
