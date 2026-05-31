import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { launchPlaywrightChromium } from "@/lib/tools/playwright-browser";
import { assertSafeUrl } from "@/lib/tools/url-guard";

const NAVIGATION_TIMEOUT_MS = 15_000;
const CLICK_TIMEOUT_MS = 8_000;
const POST_CLICK_WAIT_MS = 1_000;
const DEFAULT_TEXT_LENGTH = 2_000;
const MIN_TEXT_LENGTH = 100;
const MAX_ALLOWED_TEXT_LENGTH = 5_000;

type ParsedClickPageInput =
  | {
      ok: true;
      maxChars: number;
      selector: string;
      url: string;
    }
  | {
      message: string;
      ok: false;
    };

function normalizeMaxChars(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TEXT_LENGTH;
  }

  const rounded = Math.floor(value);
  return Math.min(Math.max(rounded, MIN_TEXT_LENGTH), MAX_ALLOWED_TEXT_LENGTH);
}

function parseClickPageObjectInput(input: ToolCallArgs): ParsedClickPageInput {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const selector = typeof input.selector === "string" ? input.selector.trim() : "";

  if (!url) {
    return {
      ok: false,
      message: 'click_page needs a non-empty "url" value.',
    };
  }

  if (!selector) {
    return {
      ok: false,
      message: 'click_page needs a non-empty "selector" value.',
    };
  }

  return {
    ok: true,
    maxChars: normalizeMaxChars(input.max_chars),
    selector,
    url,
  };
}

function parseClickPageStringInput(input: string): ParsedClickPageInput {
  const parts = input
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return {
      ok: false,
      message:
        "click_page needs both a URL and a selector. Example: https://example.com | text=More information",
    };
  }

  return {
    ok: true,
    maxChars: DEFAULT_TEXT_LENGTH,
    selector: parts[1],
    url: parts[0],
  };
}

function parseClickPageInput(input: ToolExecutionInput): ParsedClickPageInput {
  if (typeof input === "string") {
    return parseClickPageStringInput(input);
  }

  return parseClickPageObjectInput(input);
}

function normalizeUrl(rawUrl: string) {
  if (/^[a-z]+:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  return `https://${rawUrl}`;
}

function formatClickPageError(url: string, selector: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (/page\.goto: Timeout/i.test(message)) {
    return `I could not open ${url} within ${NAVIGATION_TIMEOUT_MS / 1000} seconds before trying to click anything.`;
  }

  if (/net::|ERR_|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return `I could not reach ${url}, so I could not click "${selector}".`;
  }

  if (/locator\.waitFor: Timeout/i.test(message)) {
    return `I opened ${url}, but I could not find a visible element that matched "${selector}".`;
  }

  if (/locator\.click: Timeout/i.test(message)) {
    return `I found "${selector}" on ${url}, but it did not become clickable in time.`;
  }

  if (/Invalid URL|Cannot navigate to invalid URL/i.test(message)) {
    return `I could not open "${url}" because the URL looks invalid.`;
  }

  return `I could not click "${selector}" on ${url}. ${message}`;
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function shortenVisibleText(text: string, maxChars: number) {
  const collapsed = collapseWhitespace(text);

  if (!collapsed) {
    return "(no visible text found on the page)";
  }

  if (collapsed.length <= maxChars) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxChars - 3)}...`;
}

function formatClickPageSummary(
  clickedSelector: string,
  finalUrl: string,
  pageTitle: string,
  visibleText: string,
  maxChars: number,
) {
  return [
    "CLICK_PAGE_RESULT",
    `clicked_selector: ${clickedSelector}`,
    `final_url: ${finalUrl}`,
    `page_title: ${pageTitle || "(no title)"}`,
    "visible_text_sample:",
    shortenVisibleText(visibleText, maxChars),
  ].join("\n");
}

async function executeClickPage(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseClickPageInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    assertSafeUrl(parsed.url);
  } catch (error) {
    console.warn("Blocked click_page request for unsafe URL.", { url: parsed.url });

    return {
      ok: false,
      content: formatClickPageError(parsed.url, parsed.selector, error),
    };
  }

  const browser = await launchPlaywrightChromium();

  try {
    const page = await browser.newPage();
    const targetUrl = normalizeUrl(parsed.url);

    await page.goto(targetUrl, {
      timeout: NAVIGATION_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    const target = page.locator(parsed.selector).first();
    const matchCount = await target.count();

    if (matchCount === 0) {
      return {
        ok: false,
        content: `I opened ${parsed.url}, but I could not find any element that matched "${parsed.selector}".`,
      };
    }

    await target.waitFor({
      state: "visible",
      timeout: CLICK_TIMEOUT_MS,
    });

    await target.click({
      timeout: CLICK_TIMEOUT_MS,
    });

    await page
      .waitForLoadState("domcontentloaded", {
        timeout: CLICK_TIMEOUT_MS,
      })
      .catch(() => undefined);

    await page.waitForTimeout(POST_CLICK_WAIT_MS);

    const pageTitle = (await page.title()).trim();
    const visibleText = await page.locator("body").innerText().catch(() => "");

    return {
      ok: true,
      content: formatClickPageSummary(
        parsed.selector,
        page.url(),
        pageTitle,
        visibleText,
        parsed.maxChars,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      content: formatClickPageError(parsed.url, parsed.selector, error),
    };
  } finally {
    await browser.close();
  }
}

export const clickPageTool: AgentTool = {
  name: "click_page",
  description:
    "Open one public web page, click one simple element, then return the clicked selector, final URL, page title, and a visible text sample. Use simple Playwright selectors such as text=More information or a.button.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Required public page URL to open before clicking.",
      },
      selector: {
        type: "string",
        description:
          "Required simple selector for the element to click. Example: text=More information or button.",
      },
      max_chars: {
        type: "number",
        description:
          "Optional maximum length for the visible text sample. Default 2000. Clamped to 100-5000.",
      },
    },
    required: ["url", "selector"],
    additionalProperties: false,
  },
  execute: executeClickPage,
};
