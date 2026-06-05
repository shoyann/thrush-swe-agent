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

export type DirectSafeCommandIntent =
  | {
      command: "git";
      args: ["status"];
      label: "git status";
    }
  | {
      command: "npm";
      args: ["run", "build"] | ["run", "lint"] | ["test"];
      label: "npm run build" | "npm run lint" | "npm test";
    };

function hasChinese(text: string) {
  return /[\u3400-\u9fff]/u.test(text);
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

function mentionsExplicitBuild(text: string) {
  return (
    /\bnpm\s+run\s+build\b/i.test(text) ||
    /\b(?:run|execute|start|do|check|verify)\s+(?:the\s+)?(?:build|build\s+check)\b/i.test(text) ||
    /\bbuild\s+(?:the\s+)?(?:project|app|repo|repository)\b/i.test(text) ||
    /(?:\u8fd0\u884c|\u8dd1|\u6267\u884c|\u68c0\u67e5|\u9a8c\u8bc1).{0,10}(?:npm\s+run\s+build|\u6784\u5efa|\u7f16\u8bd1)/u.test(text) ||
    /(?:\u6784\u5efa|\u7f16\u8bd1).{0,10}(?:\u68c0\u67e5|\u9a8c\u8bc1|\u8dd1\u4e00\u4e0b|\u6267\u884c\u4e00\u4e0b)/u.test(text)
  );
}

function mentionsExplicitTest(text: string) {
  return (
    /\bnpm\s+(?:run\s+)?test\b/i.test(text) ||
    /\b(?:run|execute|start|do|check|verify)\s+(?:the\s+)?(?:tests?|test\s+suite)\b/i.test(text) ||
    /\btests?\s+(?:pass|fail|passing|failing)\b/i.test(text) ||
    /(?:\u8fd0\u884c|\u8dd1|\u6267\u884c|\u68c0\u67e5|\u9a8c\u8bc1).{0,10}(?:npm\s+test|npm\s+run\s+test|\u6d4b\u8bd5)/u.test(text) ||
    /(?:\u6d4b\u8bd5).{0,10}(?:\u8dd1\u4e00\u4e0b|\u6267\u884c\u4e00\u4e0b|\u901a\u8fc7|\u5931\u8d25|\u68c0\u67e5|\u9a8c\u8bc1)/u.test(text)
  );
}

function mentionsExplicitLint(text: string) {
  return (
    /\bnpm\s+run\s+lint\b/i.test(text) ||
    /\b(?:run|execute|check|verify)\s+(?:the\s+)?lint\b/i.test(text) ||
    /(?:\u8fd0\u884c|\u8dd1|\u6267\u884c|\u68c0\u67e5|\u9a8c\u8bc1).{0,10}(?:npm\s+run\s+lint|lint|\u4ee3\u7801\u68c0\u67e5)/iu.test(text)
  );
}

export function isFileModificationRequest(task: string) {
  return (
    /(modify|edit|update|change|append|replace|rewrite|revise|write|create|overwrite|delete|remove|fix|repair|apply|implement)/i.test(task) ||
    /(\u4fee\u6539|\u7f16\u8f91|\u66f4\u65b0|\u6539\u52a8|\u66f4\u6539|\u8ffd\u52a0|\u66ff\u6362|\u91cd\u5199|\u5220\u9664|\u589e\u52a0|\u4fee\u590d|\u4fee\u597d|\u5e94\u7528\u4fee\u590d|\u5b9e\u73b0|\u5199\u5165|\u6539\u4e00\u4e0b|\u6539\u597d|\u4f60\u5012\u662f\u4fee|\u5904\u7406\u4e00\u4e0b|\u89e3\u51b3)/u.test(task)
  );
}

export function looksLikeManualEditInstructions(text: string) {
  return (
    /(manually|by hand|copy this|paste this|you should edit|change .* to |replace .* with )/i.test(text) ||
    /(\u624b\u52a8|\u81ea\u5df1\u4fee\u6539|\u4f60\u9700\u8981\u4fee\u6539|\u628a.+\u6539\u6210|\u66ff\u6362\u4e3a|\u8bf7\u5728.+\u91cc\u6539|\u590d\u5236\u8fd9\u6bb5|\u7c98\u8d34\u8fd9\u6bb5)/u.test(text)
  );
}

export function parseSessionSettingCommand(task: string): SessionSettingCommand {
  const cleanTask = task.trim();

  if (
    /^(?:auto\s*approve|autoApprove)\s*[:=]?\s*(?:true|on|yes|enable|enabled)$/i.test(cleanTask) ||
    /^(?:\u6253\u5f00|\u5f00\u542f|\u542f\u7528).{0,8}(?:auto\s*approve|autoApprove|\u5168\u81ea\u52a8|\u81ea\u52a8\u6279\u51c6|\u81ea\u52a8\u5e94\u7528)/u.test(cleanTask)
  ) {
    return {
      autoApprove: true,
      kind: "autoApprove",
    };
  }

  if (
    /^(?:auto\s*approve|autoApprove)\s*[:=]?\s*(?:false|off|no|disable|disabled)$/i.test(cleanTask) ||
    /^(?:\u5173\u95ed|\u7981\u7528).{0,8}(?:auto\s*approve|autoApprove|\u5168\u81ea\u52a8|\u81ea\u52a8\u6279\u51c6|\u81ea\u52a8\u5e94\u7528)/u.test(cleanTask)
  ) {
    return {
      autoApprove: false,
      kind: "autoApprove",
    };
  }

  return null;
}

export function extractRequiredValidations(task: string) {
  const validations: RequiredValidation[] = [];

  if (mentionsExplicitTest(task)) {
    validations.push(createValidation("npm", ["test"], "npm test"));
  }

  if (mentionsExplicitBuild(task)) {
    validations.push(createValidation("npm", ["run", "build"], "npm run build"));
  }

  if (mentionsExplicitLint(task)) {
    validations.push(createValidation("npm", ["run", "lint"], "npm run lint"));
  }

  return dedupeValidations(validations);
}

export function createImplicitNpmTestValidation(): RequiredValidation {
  return createValidation("npm", ["test"], "npm test");
}

export function getDirectSafeCommandIntent(task: string): DirectSafeCommandIntent | null {
  const cleanTask = task.trim();

  if (
    /\bgit\s+status\b/i.test(cleanTask) ||
    /(\u4ed3\u5e93\u72b6\u6001|git\u72b6\u6001|\u5f53\u524d\u72b6\u6001|\u5de5\u4f5c\u533a\u72b6\u6001|\u67e5\u770b\u72b6\u6001|\u770b\u770b\u72b6\u6001)/u.test(cleanTask)
  ) {
    return {
      command: "git",
      args: ["status"],
      label: "git status",
    };
  }

  if (mentionsExplicitBuild(cleanTask)) {
    return {
      command: "npm",
      args: ["run", "build"],
      label: "npm run build",
    };
  }

  if (mentionsExplicitTest(cleanTask)) {
    return {
      command: "npm",
      args: ["test"],
      label: "npm test",
    };
  }

  if (mentionsExplicitLint(cleanTask)) {
    return {
      command: "npm",
      args: ["run", "lint"],
      label: "npm run lint",
    };
  }

  return null;
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
    return hasAppliedOrDraftedWrite || !/(fix|repair|failing|\u5931\u8d25|\u4fee\u590d|\u4fee\u597d)/iu.test(task)
      ? "validation"
      : "diagnostic";
  }

  return hasAppliedOrDraftedWrite ? "validation" : "diagnostic";
}

export function prefersChinese(text: string) {
  return hasChinese(text);
}
