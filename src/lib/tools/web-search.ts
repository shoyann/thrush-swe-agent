import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";

const SEARCH_ENDPOINT = "https://www.bing.com/search?format=rss&q=";
const MAX_RESULTS = 5;
const MAX_CANDIDATES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

type SearchResultItem = {
  description: string;
  link: string;
  title: string;
};

type DisplaySearchResultItem = {
  link: string;
  title: string;
};

function parseTagBlock(text: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseWebSearchObjectInput(input: ToolCallArgs) {
  const query = typeof input.query === "string" ? input.query.trim() : "";

  if (!query) {
    return {
      ok: false,
      message: 'web_search needs a non-empty "query" value.',
    } as const;
  }

  return {
    ok: true,
    query,
  } as const;
}

function parseWebSearchStringInput(input: string) {
  const taggedQuery = parseTagBlock(input, "query");
  const query = taggedQuery ?? input.trim();

  if (!query) {
    return {
      ok: false,
      message:
        "web_search needs a query. Use plain text, or <query>your search words</query>.",
    } as const;
  }

  return {
    ok: true,
    query,
  } as const;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function extractItems(xml: string) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

  return items
    .map((itemMatch) => {
      const itemXml = itemMatch[1];
      const title = parseTagBlock(itemXml, "title");
      const link = parseTagBlock(itemXml, "link");
      const description = parseTagBlock(itemXml, "description");

      if (!title || !link) {
        return null;
      }

      return {
        description: collapseWhitespace(decodeHtmlEntities(description ?? "")),
        title: decodeHtmlEntities(title),
        link: decodeHtmlEntities(link),
      };
    })
    .filter((item): item is SearchResultItem => item !== null)
    .slice(0, MAX_CANDIDATES);
}

function tokenizeQuery(query: string) {
  return query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function scoreTextMatches(text: string, tokens: string[], exactWeight: number, partialWeight: number) {
  const lowerText = text.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    const lowerToken = token.toLowerCase();

    if (lowerText.includes(lowerToken)) {
      score += exactWeight;
      continue;
    }

    if (/[\u4e00-\u9fff]/u.test(token) && token.length >= 2) {
      const pieces = token.split("").filter(Boolean);
      const matchedPieces = pieces.filter((piece) => lowerText.includes(piece)).length;

      if (matchedPieces >= Math.max(2, Math.ceil(pieces.length / 2))) {
        score += partialWeight;
      }
    }
  }

  return score;
}

function scoreTimeIntent(text: string) {
  const lowerText = text.toLowerCase();
  let score = 0;

  if (/(结束|截止|到.*日|至.*日|日期|时间|展期|闭展|end|until|date|time)/iu.test(lowerText)) {
    score += 8;
  }

  if (/(展|展览|活动|museum|exhibition|show|event)/iu.test(lowerText)) {
    score += 4;
  }

  return score;
}

function scoreWhoIntent(text: string) {
  const lowerText = text.toLowerCase();
  let score = 0;

  if (/(人物|简介|介绍|是谁|百科|profile|biography|about)/iu.test(lowerText)) {
    score += 8;
  }

  return score;
}

function scoreGenericPenalty(title: string, query: string) {
  const lowerTitle = title.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (
    /(北京市|beijing|百科|政府门户网站|旅游攻略)/iu.test(lowerTitle) &&
    !lowerTitle.includes(lowerQuery)
  ) {
    return -10;
  }

  return 0;
}

function rerankResults(query: string, results: SearchResultItem[]) {
  const tokens = tokenizeQuery(query);
  const asksWhen = /(结束时间|开始时间|时间|日期)/u.test(query);
  const asksWho = /(人物|简介)/u.test(query);

  return [...results]
    .map((result, index) => {
      const combinedText = `${result.title} ${result.description} ${result.link}`;
      let score = 0;

      score += scoreTextMatches(result.title, tokens, 16, 5);
      score += scoreTextMatches(result.description, tokens, 8, 3);
      score += scoreTextMatches(result.link, tokens, 6, 2);

      if (asksWhen) {
        score += scoreTimeIntent(combinedText);
      }

      if (asksWho) {
        score += scoreWhoIntent(combinedText);
      }

      score += scoreGenericPenalty(result.title, query);

      return {
        ...result,
        index,
        score,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.index - right.index;
    })
    .slice(0, MAX_RESULTS)
    .map((result) => ({
      description: result.description,
      link: result.link,
      title: result.title,
    }));
}

function formatResults(query: string, results: DisplaySearchResultItem[]) {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }

  return [
    `Web search results for "${query}":`,
    ...results.flatMap((result, index) => [
      `${index + 1}. ${result.title}`,
      `   ${result.link}`,
    ]),
  ].join("\n");
}

function toDisplayResults(results: SearchResultItem[]): DisplaySearchResultItem[] {
  return results.map((result) => ({
    link: result.link,
    title: result.title,
  }));
}

function parseWebSearchInput(input: ToolExecutionInput) {
  if (typeof input === "string") {
    return parseWebSearchStringInput(input);
  }

  return parseWebSearchObjectInput(input);
}

async function executeWebSearch(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseWebSearchInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${SEARCH_ENDPOINT}${encodeURIComponent(parsed.query)}`,
      {
        headers: {
          "User-Agent": "Mini-Codex-MVP/0.1",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return {
        ok: false,
        content: `web_search failed with status ${response.status}.`,
      };
    }

    const xml = await response.text();
    const results = rerankResults(parsed.query, extractItems(xml));

    return {
      ok: true,
      content: formatResults(parsed.query, toDisplayResults(results)),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "web_search could not reach the search endpoint.";

    return {
      ok: false,
      content: message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const webSearchTool: AgentTool = {
  name: "web_search",
  description:
    "Search the public web and return a short list of page titles and links. Input: plain search text, or <query>search words</query>.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Required public web search query.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  execute: executeWebSearch,
};
