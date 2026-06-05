import { parseTagBlock } from "@/lib/agent/tool-args";
import {
  createSyntheticToolCallId,
  type DirectToolPlan,
} from "@/lib/agent/tool-run-types";
import type { PlannedToolCall } from "@/lib/agent/model-client";
import { getDirectSafeCommandIntent } from "@/lib/agent/intent-classifier";

type DirectToolPlanRule = {
  derive: (goal: string) => DirectToolPlan | null;
  match: (goal: string) => boolean;
};

function extractUrlFromTask(task: string) {
  const match = task.match(/https?:\/\/[^\s)>"']+|www\.[^\s)>"']+/i);
  return match?.[0]?.trim() ?? null;
}

function cleanClickTargetLabel(rawLabel: string) {
  return rawLabel
    .trim()
    .replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveClickSelectorFromTask(task: string) {
  if (/\bclick\s+the\s+first\s+link\b/i.test(task) || /\u70b9\u51fb\u7b2c\u4e00\u4e2a\u94fe\u63a5/u.test(task)) {
    return "a";
  }

  if (/\bclick\s+the\s+first\s+button\b/i.test(task) || /\u70b9\u51fb\u7b2c\u4e00\u4e2a\u6309\u94ae/u.test(task)) {
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

  const chineseLinkMatch = task.match(/\u70b9\u51fb(.+?)\u94fe\u63a5/u);
  if (chineseLinkMatch?.[1]) {
    const label = cleanClickTargetLabel(chineseLinkMatch[1]);
    if (label) {
      return `text=${label}`;
    }
  }

  const chineseButtonMatch = task.match(/\u70b9\u51fb(.+?)\u6309\u94ae/u);
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

  const chineseMatch = task.match(/(\d{2,4})\s*(?:\u5b57|\u5b57\u7b26)/u);
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

export function deriveDirectReadPageToolCall(
  task: string,
): DirectToolPlan | null {
  const url = extractUrlFromTask(task);
  const maxChars = deriveMaxCharsFromTask(task);

  if (!url) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "read_page",
    input:
      maxChars === null
        ? {
            url,
          }
        : {
            url,
            max_chars: maxChars,
          },
  };
}

export function deriveDirectSafeCommandToolCall(
  task: string,
): DirectToolPlan | null {
  const commandIntent = getDirectSafeCommandIntent(task);

  if (!commandIntent) {
    return null;
  }

  return {
    id: createSyntheticToolCallId(),
    name: "safe_command",
    input: {
      command: commandIntent.command,
      args: commandIntent.args,
    },
  };
}

function extractIssueNumber(task: string) {
  return (
    task.match(/\bissues?\/(\d+)\b/i)?.[1] ??
    task.match(/\bissue\s+#?(\d+)\b/i)?.[1] ??
    task.match(/\u7b2c\s*(\d+)\s*\u4e2a?\s*issue/iu)?.[1] ??
    task.match(/issue\s*(?:\u8be6\u60c5|\u7f16\u53f7)?\s*#?(\d+)/iu)?.[1] ??
    null
  );
}

export function deriveDirectGitInspectToolCall(
  task: string,
): DirectToolPlan | null {
  const cleanTask = task.trim();
  const issueNumber = extractIssueNumber(cleanTask);
  const asksForIssuePlan =
    /(issue\s*(\u8ba1\u5212|execution\s*plan)|\u6267\u884c\u8ba1\u5212|\u6539\u4ee3\u7801\u8ba1\u5212|\u8f6c\u4e3a\u6267\u884c\u8ba1\u5212)/iu.test(cleanTask);

  if (asksForIssuePlan && issueNumber) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_plan",
        issue_number: Number(issueNumber),
      },
    };
  }

  if (issueNumber && !extractUrlFromTask(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_detail",
        issue_number: Number(issueNumber),
      },
    };
  }

  if (/\bissues?\b/i.test(cleanTask) || /(issue \u5217\u8868|issues \u5217\u8868|\u5f53\u524d issue|\u4ed3\u5e93 issue|\u5f85\u529e|\u95ee\u9898\u5217\u8868)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "issue_list",
      },
    };
  }

  if (/\b(?:repo|repository)\b/i.test(cleanTask) || /(\u4ed3\u5e93\u4fe1\u606f|\u5f53\u524d\u4ed3\u5e93|\u4ed3\u5e93\u8be6\u60c5|github \u4ed3\u5e93\u4fe1\u606f)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "repo_info",
      },
    };
  }

  if (/\btask[_\s-]?submit\b/i.test(cleanTask) || /(\u4efb\u52a1\u63d0\u4ea4|\u63d0\u4ea4\u8349\u7a3f|\u63d0\u4ea4\u4efb\u52a1\u8349\u7a3f|\u751f\u6210\u63d0\u4ea4\u8349\u7a3f)/u.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "task_submit",
      },
    };
  }

  if (/\b(?:patch|patch\s+export|export\s+patch|diff\s+patch)\b/i.test(cleanTask) || /(\u5bfc\u51fa\u8865\u4e01|\u8865\u4e01\u5bfc\u51fa|\u751f\u6210\u8865\u4e01|\u8f93\u51fa\u8865\u4e01|\u8865\u4e01\u6587\u672c)/u.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "patch_export",
      },
    };
  }

  if (/\bpr\b/i.test(cleanTask) || /(pr \u8349\u7a3f|pull request|\u62c9\u53d6\u8bf7\u6c42|\u5408\u5e76\u8bf7\u6c42|pr \u6587\u6848|pr draft|\u5e2e\u6211\u5199 pr)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "pr_draft",
      },
    };
  }

  if (/\bcommit\s+message\b/i.test(cleanTask) || /(\u63d0\u4ea4\u8bf4\u660e|\u63d0\u4ea4\u4fe1\u606f|commit \u6587\u6848|commit message|\u5e2e\u6211\u5199\u63d0\u4ea4\u4fe1\u606f|\u5e2e\u6211\u5199 commit)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "commit_message",
      },
    };
  }

  if (
    /\bgh\b/i.test(cleanTask) ||
    /(github|remote|origin).{0,12}(\u8fde\u63a5|\u8fde\u4e0a|\u73af\u5883|\u72b6\u6001|\u68c0\u67e5|\u914d\u7f6e)/iu.test(cleanTask) ||
    /(\u6709\u6ca1\u6709\s*remote|\u6709\u6ca1\u6709\s*github\s*remote|\u80fd\u4e0d\u80fd\u7528\s*gh|github\s*\u767b\u5f55|gh\s*\u767b\u5f55)/iu.test(cleanTask)
  ) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "github_env",
      },
    };
  }

  if (/(?:git|change|diff|status)\s+summary/i.test(cleanTask) || /(\u53d8\u66f4\u603b\u7ed3|\u6539\u52a8\u603b\u7ed3|\u603b\u7ed3\u6539\u52a8|\u603b\u7ed3\u53d8\u66f4|git\u603b\u7ed3|git \u6458\u8981|change summary)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "summary",
      },
    };
  }

  if (/\bgit\s+diff\b/i.test(cleanTask) || /(git\s*diff|\u4ed3\u5e93\u5dee\u5f02|\u6539\u52a8\u5dee\u5f02|\u53d8\u66f4\u5dee\u5f02|\u67e5\u770b\u5dee\u5f02|\u770b\u770b\u5dee\u5f02)/iu.test(cleanTask)) {
    return {
      id: createSyntheticToolCallId(),
      name: "git_inspect",
      input: {
        action: "diff",
      },
    };
  }

  if (/\bgit\s+status\b/i.test(cleanTask) || /(git\s*\u72b6\u6001|\u4ed3\u5e93\u72b6\u6001|\u5de5\u4f5c\u533a\u72b6\u6001|\u6539\u52a8\u72b6\u6001|\u67e5\u770b\u72b6\u6001|\u770b\u770b\u72b6\u6001)/iu.test(cleanTask)) {
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
    /(\u662f\u4e0d\u662f|\u662f\u5426|\u7b97\u4e0d\u7b97|\u5f53\u524d\u76ee\u5f55|\u8fd9\u4e2a\u76ee\u5f55|\u8fd9\u4e2a\u9879\u76ee).{0,12}(git\s*\u4ed3\u5e93|git\s*repo|git\s*repository)/iu.test(cleanTask) ||
    /(git\s*\u4ed3\u5e93|git\s*repo|git\s*repository).{0,12}(\u5417|\u6709\u6ca1\u6709|\u60c5\u51b5|\u72b6\u6001|\u68c0\u67e5)/iu.test(cleanTask);

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

const directToolPlanRules: DirectToolPlanRule[] = [
  {
    match: (goal) => !!extractUrlFromTask(goal) && !!deriveClickSelectorFromTask(goal),
    derive: deriveDirectClickToolCall,
  },
  {
    match: (goal) => !!deriveDirectReadPageToolCall(goal),
    derive: deriveDirectReadPageToolCall,
  },
  {
    match: (goal) => !!derivePastedIssuePlanToolCall(goal),
    derive: derivePastedIssuePlanToolCall,
  },
  {
    match: (goal) => !!deriveDirectGitInspectToolCall(goal),
    derive: deriveDirectGitInspectToolCall,
  },
  {
    match: (goal) => !!deriveDirectSafeCommandToolCall(goal),
    derive: deriveDirectSafeCommandToolCall,
  },
];

export function deriveDirectToolPlan(goal: string) {
  for (const rule of directToolPlanRules) {
    if (!rule.match(goal)) {
      continue;
    }

    const plan = rule.derive(goal);

    if (plan) {
      return plan;
    }
  }

  return null;
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

function cleanSearchQuery(text: string) {
  let query = text.trim();

  query = stripLeadingMatch(query, [
    /^(?:\u8bf7\u5e2e\u6211|\u5e2e\u6211|\u8bf7\u4f60|\u9ebb\u70e6\u4f60|\u9ebb\u70e6)\s*/u,
    /^(?:\u5728\u7f51\u4e0a|\u4e0a\u7f51|\u5728\u7ebf)\s*/u,
    /^(?:\u641c\u7d22\u4e00\u4e0b|\u641c\u7d22|\u641c\u4e00\u4e0b|\u641c\u4e00\u641c|\u641c\u641c|\u67e5\u4e00\u4e0b|\u67e5\u4e00\u67e5|\u67e5\u67e5|\u67e5\u627e|\u67e5\u8be2|\u627e\u4e00\u4e0b)\s*/u,
    /^(?:about|regarding|\u5173\u4e8e)\s*/iu,
    /^(?:please\s+)?(?:search|look up|find)\s+(?:for\s+)?/iu,
  ]);

  query = stripTrailingMatch(query, [
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u7136\u540e|\u5e76\u4e14)?\s*(?:\u628a|\u5c06)?\s*(?:\u7f51\u9875)?\u6807\u9898\u548c\u94fe\u63a5\s*(?:\u544a\u8bc9\u6211|\u7ed9\u6211|\u53d1\u6211)?\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u53ea\u8981|\u53ea\u9700\u8981)\s*(?:\u7f51\u9875)?\u6807\u9898\u548c\u94fe\u63a5\s*$/u,
    /[\u3002\uFF0C\uFF01\uFF1F,!.?]?\s*(?:\u544a\u8bc9\u6211|\u7ed9\u6211|\u53d1\u6211|\u5217\u51fa\u6765)\s*$/u,
    /\s*(?:and\s+)?(?:give|tell|show)\s+me\s+(?:the\s+)?title(?:s)?\s+and\s+link(?:s)?\s*$/iu,
  ]);

  return query
    .replace(/[\u3002\uFF0C\uFF01\uFF1F,!.?]+/gu, " ")
    .replace(/^["'\u201c\u201d\u2018\u2019`\s]+|["'\u201c\u201d\u2018\u2019`\s]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveWebSearchQueryFromTask(task: string) {
  const taggedQuery = parseTagBlock(task, "query");
  if (taggedQuery) {
    return taggedQuery;
  }

  return cleanSearchQuery(task) || task.trim();
}

function hasWhoSearchIntent(text: string) {
  return /(?:\u662f\u8c01|\u4ec0\u4e48\u4eba|\u8c01\u554a|\u8c01\u5440)/u.test(text);
}

function hasWhenSearchIntent(text: string) {
  return /(?:\u4ec0\u4e48\u65f6\u5019|\u5565\u65f6\u5019|\u4f55\u65f6|\u51e0\u70b9|\u51e0\u53f7|\u54ea\u5929|when|what\s+time|what\s+date)/iu.test(text);
}

function hasEndSearchIntent(text: string) {
  return /(?:\u7ed3\u675f|\u622a\u6b62|end|ending|ends)/iu.test(text);
}

function hasStartSearchIntent(text: string) {
  return /(?:\u5f00\u59cb|\u5f00\u5e55|start|begin|opening)/iu.test(text);
}

function appendSearchTerms(query: string, suffix: string) {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();

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

  let query = cleanSearchQuery(originalTask)
    .replace(/(?:\u662f\u8c01|\u4ec0\u4e48\u4eba|\u8c01\u554a|\u8c01\u5440|\u4ec0\u4e48\u65f6\u5019|\u5565\u65f6\u5019|\u4f55\u65f6|\u51e0\u70b9|\u51e0\u53f7|\u54ea\u5929|\u4ec0\u4e48\u65f6\u5019\u7ed3\u675f|\u622a\u6b62|\u5f00\u59cb|\u5f00\u5e55)/gu, " ")
    .replace(/\b(?:who|when|what\s+time|what\s+date)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (asksWho) {
    query = appendSearchTerms(query, "\u4eba\u7269 \u7b80\u4ecb");
  } else if (asksWhen && asksEnd) {
    query = appendSearchTerms(query, "\u7ed3\u675f\u65f6\u95f4");
  } else if (asksWhen && asksStart) {
    query = appendSearchTerms(query, "\u5f00\u59cb\u65f6\u95f4");
  } else if (asksWhen) {
    query = appendSearchTerms(query, "\u65f6\u95f4 \u65e5\u671f");
  }

  return query || originalTask;
}
