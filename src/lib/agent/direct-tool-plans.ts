import { parseTagBlock } from "@/lib/agent/tool-args";

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
