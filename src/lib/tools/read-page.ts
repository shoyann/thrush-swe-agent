import type {
  AgentTool,
  ToolCallArgs,
  ToolExecutionInput,
  ToolResult,
} from "@/lib/tools/types";
import { launchPlaywrightChromium } from "@/lib/tools/playwright-browser";
import { assertSafeUrl } from "@/lib/tools/url-guard";

const NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 2_000;
const MIN_TEXT_LENGTH = 100;
const MAX_ALLOWED_TEXT_LENGTH = 5_000;

type ParsedReadPageInput =
  | {
      ok: true;
      maxChars: number;
      url: string;
    }
  | {
      message: string;
      ok: false;
    };

function normalizeMaxChars(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MAX_TEXT_LENGTH;
  }

  const rounded = Math.floor(value);
  return Math.min(Math.max(rounded, MIN_TEXT_LENGTH), MAX_ALLOWED_TEXT_LENGTH);
}

function parseReadPageObjectInput(input: ToolCallArgs) {
  const url = typeof input.url === "string" ? input.url.trim() : "";

  if (!url) {
    return {
      ok: false,
      message: 'read_page needs a non-empty "url" value.',
    } as const;
  }

  return {
    ok: true,
    maxChars: normalizeMaxChars(input.max_chars),
    url,
  } as const;
}

function parseReadPageStringInput(input: string) {
  const url = input.trim();

  if (!url) {
    return {
      ok: false,
      message: "read_page needs a URL to open.",
    } as const;
  }

  return {
    ok: true,
    maxChars: MAX_TEXT_LENGTH,
    url,
  } as const;
}

function parseReadPageInput(input: ToolExecutionInput): ParsedReadPageInput {
  if (typeof input === "string") {
    return parseReadPageStringInput(input);
  }

  return parseReadPageObjectInput(input);
}

function normalizeUrl(rawUrl: string) {
  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  return `https://${rawUrl}`;
}

function formatReadPageError(url: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (/page\.goto: Timeout/i.test(message)) {
    return `I could not open ${url} within ${NAVIGATION_TIMEOUT_MS / 1000} seconds.`;
  }

  if (/net::|ERR_|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return `I could not reach ${url}. The page did not load successfully.`;
  }

  if (/Invalid URL|Cannot navigate to invalid URL/i.test(message)) {
    return `I could not open "${url}" because the URL looks invalid.`;
  }

  return `I could not read ${url}. ${message}`;
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

function formatPageSummary(
  url: string,
  title: string,
  visibleText: string,
  maxChars: number,
) {
  return [
    "READ_PAGE_RESULT",
    `final_url: ${url}`,
    `page_title: ${title || "(no title)"}`,
    "visible_text_sample:",
    shortenVisibleText(visibleText, maxChars),
  ].join("\n");
}

async function executeReadPage(input: ToolExecutionInput): Promise<ToolResult> {
  const parsed = parseReadPageInput(input);

  if (!parsed.ok) {
    return {
      ok: false,
      content: parsed.message,
    };
  }

  try {
    assertSafeUrl(parsed.url);
  } catch (error) {
    console.warn("Blocked read_page request for unsafe URL.", { url: parsed.url });

    return {
      ok: false,
      content: formatReadPageError(parsed.url, error),
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

    const title = (await page.title()).trim();
    const visibleText = await page.locator("body").innerText().catch(() => "");

    return {
      ok: true,
      content: formatPageSummary(
        page.url(),
        title,
        visibleText,
        parsed.maxChars,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      content: formatReadPageError(parsed.url, error),
    };
  } finally {
    await browser.close();
  }
}

export const readPageTool: AgentTool = {
  name: "read_page",
  description:
    "Open one public web page in a headless browser, then return the final URL, page title, and a sample of visible page text. Optional: set max_chars to cap the visible text sample length.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Required public page URL to open and read.",
      },
      max_chars: {
        type: "number",
        description:
          "Optional maximum length for the visible text sample. Default 2000. Clamped to 100-5000.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  execute: executeReadPage,
};
