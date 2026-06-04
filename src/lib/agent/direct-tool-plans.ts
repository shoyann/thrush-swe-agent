import { parseTagBlock } from "@/lib/agent/tool-args";
import {
  createSyntheticToolCallId,
  type DirectToolPlan,
} from "@/lib/agent/tool-run-types";
import type { PlannedToolCall } from "@/lib/agent/model-client";

function extractUrlFromTask(task: string) {
  const match = task.match(/https?:\/\/[^\s)>"']+|www\.[^\s)>"']+/i);
  return match?.[0]?.trim() ?? null;
}

function cleanClickTargetLabel(rawLabel: string) {
  return rawLabel
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveClickSelectorFromTask(task: string) {
  if (/\bclick\s+the\s+first\s+link\b/i.test(task) || /点击第一个链接/u.test(task)) {
    return "a";
  }

  if (/\bclick\s+the\s+first\s+button\b/i.test(task) || /点击第一个按钮/u.test(task)) {
    return "button";
  }

  const englishLinkMatch = task.match(/\bclick\s+(?:the\s+)?(.+?)\s+link\b/i);
  if (englishLinkMatch?.[1]) {
    const label = cleanClickTargetLabel(englishLinkMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const englishButtonMatch = task.match(/\bclick\s+(?:the\s+)?(.+?)\s+button\b/i);
  if (englishButtonMatch?.[1]) {
    const label = cleanClickTargetLabel(englishButtonMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const chineseLinkMatch = task.match(/点击(.+?)链接/u);
  if (chineseLinkMatch?.[1]) {
    const label = cleanClickTargetLabel(chineseLinkMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const chineseButtonMatch = task.match(/点击(.+?)按钮/u);
  if (chineseButtonMatch?.[1]) {
    const label = cleanClickTargetLabel(chineseButtonMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  return null;
}

function deriveMaxCharsFromTask(task: string) {
  const englishMatch = task.match(
    /\b(?:around|about|roughly|only|just)?\s*(\d{2,4})\s*(?:characters|character|chars)\b/i,
  );
  if (englishMatch?.[1]) {
    return Number(englishMatch[1]);
  }

  const chineseMatch = task.match(/(\d{2,4})\s*(?:字|字符)/u);
  if (chineseMatch?.[1]) {
    return Number(chineseMatch[1]);
  }

  return null;
}

export function deriveDirectClickToolCall(
  task: string,
): PlannedToolCall | null {
  const url = extractUrlFromTask(task);
  const selector = deriveClickSelectorFromTask(task);
  const maxChars = deriveMaxCharsFromTask(task);

  if (!url || !selector) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "click_page",
    input:
      maxChars === null
        ? {
            url,
            selector,
          }
        : {
            url,
            selector,
            max_chars: maxChars,
          },
  };
}

export function deriveDirectSafeCommandToolCall(
  task: string,
): DirectToolPlan | null {
  const cleanTask = task.trim();

  const asksForGitStatus =
    /\bgit\s+status\b/i.test(cleanTask) ||
    /(仓库状态|git状态|当前状态|工作区状态)/u.test(cleanTask);

  if (asksForGitStatus) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "git",
        args: ["status"],
      },
    };
  }

  const asksForBuild =
    /\bnpm\s+run\s+build\b/i.test(cleanTask) ||
    /\bbuild\b/i.test(cleanTask) ||
    /(构建|编译|跑一下构建|构建检查|验证构建|检查能不能构建)/u.test(cleanTask);

  if (asksForBuild) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "npm",
        args: ["run", "build"],
      },
    };
  }

  const asksForTest =
    /\bnpm\s+test\b/i.test(cleanTask) ||
    /\btest\b/i.test(cleanTask) ||
    /(测试|跑测试|执行测试|验证测试|检查测试)/u.test(cleanTask);

  if (asksForTest) {
    return {
      id: createSyntheticToolCallId(),
      name: "safe_command",
      input: {
        command: "npm",
        args: ["test"],
      },
    };
  }

  return null;
}

export function deriveDirectGitInspectToolCall(
  task: string,
): DirectToolPlan | null {
  const cleanTask = task.trim();
  const asksForIssuePlan =
    /(issue\s*(计划|execution\s*plan)|执行计划|改代码计划)/iu.test(cleanTask);
  const issueDetailMatch =
    cleanTask.match(/\bissue\s+#?(\d+)\b/i) ||
    cleanTask.match(/issue\s*详情\s*#?(\d+)/iu) ||
    cleanTask.match(/第\s*(\d+)\s*个\s*issue/iu) ||
    cleanTask.match(/issue\s*(\d+)/iu);

  if (asksForIssuePlan && issueDetailMatch?.[1]) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_plan",
        issue_number: Number(issueDetailMatch[1]),
      },
    };
  }

  if (issueDetailMatch?.[1]) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_detail",
        issue_number: Number(issueDetailMatch[1]),
      },
    };
  }

  const asksForIssueList =
    /\bissues?\b/i.test(cleanTask) ||
    /(issue 列表|issues 列表|当前 issue|仓库 issue|待办|问题列表)/iu.test(cleanTask);

  if (asksForIssueList) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_list",
      },
    };
  }

  const asksForRepoInfo =
    /\brepo\b/i.test(cleanTask) ||
    /(仓库信息|当前仓库|repo info|repository info|仓库详情|github 仓库信息)/iu.test(cleanTask);

  if (asksForRepoInfo) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "repo_info",
      },
    };
  }

  const asksForTaskSubmit =
    /\btask[_\s-]?submit\b/i.test(cleanTask) ||
    /(任务提交|提交草稿|提交任务草稿|生成提交草稿)/u.test(cleanTask);

  if (asksForTaskSubmit) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "task_submit",
      },
    };
  }

  const asksForPatchExport =
    /\b(?:patch|patch\s+export|export\s+patch|diff\s+patch)\b/i.test(cleanTask) ||
    /(导出补丁|补丁导出|生成补丁|输出补丁|补丁文本)/u.test(cleanTask);

  if (asksForPatchExport) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "patch_export",
      },
    };
  }

  const asksForPrDraft =
    /\bpr\b/i.test(cleanTask) ||
    /(pr 草稿|pull request|拉取请求|合并请求|pr 文案|pr draft|帮我写 pr)/iu.test(cleanTask);

  if (asksForPrDraft) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "pr_draft",
      },
    };
  }

  const asksForCommitMessage =
    /\bcommit\s+message\b/i.test(cleanTask) ||
    /(提交说明|提交信息|commit 文案|commit message|帮我写提交信息|帮我写 commit)/iu.test(cleanTask);

  if (asksForCommitMessage) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "commit_message",
      },
    };
  }

  const asksForGithubEnv =
    /\bgh\b/i.test(cleanTask) ||
    /(github|remote|origin).{0,12}(连接|连上|环境|状态|检查|配置)/iu.test(cleanTask) ||
    /(有没有\s*remote|有没有\s*github\s*remote|能不能用\s*gh|github\s*登录|gh\s*登录)/iu.test(
      cleanTask,
    );

  if (asksForGithubEnv) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "github_env",
      },
    };
  }

  const asksForGitSummary =
    /(?:git|change|diff|status)\s+summary/i.test(cleanTask) ||
    /(变更总结|改动总结|总结改动|总结变更|git总结|git 摘要|change summary)/iu.test(cleanTask);

  if (asksForGitSummary) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "summary",
      },
    };
  }

  const asksForGitDiff =
    /\bgit\s+diff\b/i.test(cleanTask) ||
    /(git\s*diff|仓库差异|改动差异|变更差异|查看差异|看看差异)/iu.test(cleanTask);

  if (asksForGitDiff) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "diff",
      },
    };
  }

  const asksForGitStatus =
    /\bgit\s+status\b/i.test(cleanTask) ||
    /(git\s*状态|仓库状态|工作区状态|改动状态|查看状态|看看状态)/iu.test(cleanTask);

  if (asksForGitStatus) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "status",
      },
    };
  }

  const asksWhetherGitRepo =
    /\bgit\s+(repo|repository)\b/i.test(cleanTask) ||
    /(是不是|是否|算不算|当前目录|这个目录|这个项目).{0,12}(git\s*仓库|git\s*repo|git\s*repository)/iu.test(
      cleanTask,
    ) ||
    /(git\s*仓库|git\s*repo|git\s*repository).{0,12}(吗|有没有|情况|状态|检查)/iu.test(
      cleanTask,
    );

  if (!asksWhetherGitRepo) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "git_inspect",
    input: {
      action: "check_repo",
    },
  };
}

export function derivePastedIssuePlanToolCall(
  task: string,
): DirectToolPlan | null {
  const cleanTask = task.trim();
  const hasPastedIssueText =
    /(?:^|\n)\s*title\s*:/i.test(cleanTask) &&
    /(?:^|\n)\s*body\s*:/i.test(cleanTask);
  const mentionsIssue = /\bissue\b/i.test(cleanTask);

  if (!hasPastedIssueText || !mentionsIssue) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "git_inspect",
    input: {
      action: "issue_plan",
      issue_text: cleanTask,
    },
  };
}

function stripLeadingMatch(text: string, patterns: RegExp[]) {
  let nextText = text.trim();

  for (const pattern of patterns) {
    const updated = nextText.replace(pattern, "").trim();
    if (updated !== nextText) {
      nextText = updated;
    }
  }

  return nextText;
}

function stripTrailingMatch(text: string, patterns: RegExp[]) {
  let nextText = text.trim();

  for (const pattern of patterns) {
    const updated = nextText.replace(pattern, "").trim();
    if (updated !== nextText) {
      nextText = updated;
    }
  }

  return nextText;
}

export function deriveWebSearchQueryFromTask(task: string) {
  const taggedQuery = parseTagBlock(task, "query");
  if (taggedQuery) {
    return taggedQuery;
  }

  let query = task.trim();

  query = stripLeadingMatch(query, [
    /^(?:请帮我|帮我|请你|请|麻烦你|麻烦)\s*/u,
    /^(?:在网上|上网|在线)\s*/u,
    /^(?:搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查找|查询|找一下)\s*/u,
    /^(?:关于|一下)\s*/u,
    /^(?:please\s+)?(?:search|look up|find)\s+(?:for\s+)?/iu,
  ]);

  query = stripTrailingMatch(query, [
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:并|然后|再)?\s*(?:把|将)?\s*(?:网页)?标题和链接(?:告诉我|给我|发我)?\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:只要|只需要)?\s*(?:网页)?标题和链接\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:告诉我|给我|发我|列出来)\s*$/u,
    /\s*(?:and\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?title(?:s)?\s+and\s+link(?:s)?\s*$/iu,
  ]);

  query = query.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, "").trim();

  return query || task.trim();
}

function hasWhoSearchIntent(text: string) {
  return /(?:是谁|什么人|谁啊|谁呀)/u.test(text);
}

function hasWhenSearchIntent(text: string) {
  return /(?:什么时候|啥时候|何时|几点|几号|哪天|when|what\s+time|what\s+date)/iu.test(
    text,
  );
}

function hasEndSearchIntent(text: string) {
  return /(?:结束|截止|end|ending|ends)/iu.test(text);
}

function hasStartSearchIntent(text: string) {
  return /(?:开始|开幕|start|begin|opening)/iu.test(text);
}

function collapseSearchTerms(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function appendSearchTerms(query: string, suffix: string) {
  const normalizedQuery = collapseSearchTerms(query);

  if (!normalizedQuery) {
    return suffix;
  }

  if (normalizedQuery.toLowerCase().includes(suffix.toLowerCase())) {
    return normalizedQuery;
  }

  return `${normalizedQuery} ${suffix}`;
}

export function deriveFocusedWebSearchQuery(task: string) {
  const taggedQuery = parseTagBlock(task, "query");
  if (taggedQuery) {
    return taggedQuery;
  }

  const originalTask = task.trim();
  const asksWho = hasWhoSearchIntent(originalTask);
  const asksWhen = hasWhenSearchIntent(originalTask);
  const asksEnd = hasEndSearchIntent(originalTask);
  const asksStart = hasStartSearchIntent(originalTask);

  let query = originalTask;

  query = stripLeadingMatch(query, [
    /^(?:请帮我|帮我|请你|请|麻烦你|麻烦)\s*/u,
    /^(?:在网上|上网|在线)\s*/u,
    /^(?:搜索一下|搜索|搜一下|搜一搜|搜搜|查一下|查一查|查查|查找|查询|找一下)\s*/u,
    /^(?:关于|一下)\s*/u,
    /^(?:please\s+)?(?:search|look up|find)\s+(?:for\s+)?/iu,
  ]);

  query = stripTrailingMatch(query, [
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:并|然后|再)?\s*(?:把|将)?\s*(?:网页)?标题和链接(?:告诉我|给我|发我)?\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:只要|只需要)?\s*(?:网页)?标题和链接\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:告诉我|给我|发我|列出来)\s*$/u,
    /\s*(?:and\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?title(?:s)?\s+and\s+link(?:s)?\s*$/iu,
  ]);

  query = collapseSearchTerms(
    query
      .replace(/[\u3002\uFF0C\uFF01\uFF1F,!.?]+/gu, " ")
      .replace(/([\p{Script=Han}])在(?=[A-Za-z0-9])/gu, "$1 ")
      .replace(/(?<=[\p{Script=Han}])(?=[A-Za-z0-9])/gu, " ")
      .replace(/(?<=[A-Za-z0-9])(?=[\p{Script=Han}])/gu, " ")
      .replace(
        /(?:是谁|什么人|谁啊|谁呀|什么时候|啥时候|何时|几点|几号|哪天|什么时间|结束|截止|开始|开幕)/gu,
        " ",
      )
      .replace(/\b(?:who|when|what\s+time|what\s+date)\b/giu, " ")
      .replace(/[\u201c\u201d"'`\u2018\u2019]+/gu, " "),
  );

  if (asksWho) {
    query = appendSearchTerms(query, "人物 简介");
  } else if (asksWhen && asksEnd) {
    query = appendSearchTerms(query, "结束时间");
  } else if (asksWhen && asksStart) {
    query = appendSearchTerms(query, "开始时间");
  } else if (asksWhen) {
    query = appendSearchTerms(query, "时间 日期");
  }

  return query || originalTask;
}
