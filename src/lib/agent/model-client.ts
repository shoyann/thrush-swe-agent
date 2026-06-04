import OpenAI from "openai";
import type { ToolCallArgs } from "@/lib/tools/types";
import { listTools } from "@/lib/tools/tool-registry";

export type PlannedToolCall = {
  id: string;
  input: ToolCallArgs;
  name: string;
};

export type ModelTextMessage = {
  content: string;
  reasoning_content?: string | null;
};

export type ModelToolMessage = {
  assistantMessage: LlmMessage;
  content: string | null;
  toolCall: PlannedToolCall | null;
};

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<{ text?: string; type?: string }> | null;
  reasoning_content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type ModelProvider = "anthropic" | "deepseek" | "openai";

export type ModelClientConfig = {
  apiKey?: string;
  baseURL?: string;
};

function getConfiguredProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.trim().toLowerCase();

  if (!provider) {
    return "deepseek";
  }

  if (
    provider === "anthropic" ||
    provider === "deepseek" ||
    provider === "openai"
  ) {
    return provider;
  }

  throw new Error(
    'MODEL_PROVIDER must be one of "deepseek", "openai", or "anthropic".',
  );
}

function getProviderDefaults(provider: ModelProvider) {
  if (provider === "deepseek") {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      missingKeyMessage: "Missing DEEPSEEK_API_KEY.",
    };
  }

  if (provider === "openai") {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      missingKeyMessage: "Missing OPENAI_API_KEY.",
    };
  }

  return {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    missingKeyMessage: "Missing ANTHROPIC_API_KEY.",
  };
}

function getProviderExtraBody(provider: ModelProvider) {
  if (provider !== "deepseek") {
    return undefined;
  }

  return {
    thinking: {
      type: "disabled",
    },
  };
}

export function getConfiguredModelName() {
  const provider = getConfiguredProvider();

  if (provider === "deepseek") {
    return process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  }

  if (provider === "openai") {
    return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  }

  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
}

function createModelClient(
  provider: ModelProvider,
  config: ModelClientConfig = {},
) {
  const defaults = getProviderDefaults(provider);
  const apiKey = config.apiKey ?? defaults.apiKey;

  if (!apiKey) {
    throw new Error(defaults.missingKeyMessage);
  }

  if (provider === "anthropic" && !(config.baseURL ?? defaults.baseURL)) {
    throw new Error(
      "ANTHROPIC_BASE_URL is required because the current model client uses the OpenAI-compatible chat completions interface.",
    );
  }

  const baseURL = config.baseURL ?? defaults.baseURL;

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

function getMessageTextContent(
  content: string | Array<{ text?: string; type?: string }> | null | undefined,
) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getReasoningContent(message: unknown) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof reasoningContent === "string" ? reasoningContent : null;
}

function buildModelTools(allowedToolNames?: string[]) {
  const allowedSet = allowedToolNames ? new Set(allowedToolNames) : null;

  return listTools()
    .filter((tool) => (allowedSet ? allowedSet.has(tool.name) : true))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
}

function parseToolCallArguments(rawArguments: string) {
  try {
    const parsed = JSON.parse(rawArguments) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as ToolCallArgs;
  } catch {
    return null;
  }
}

function createSyntheticToolCallId() {
  return `tool-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function callModelForText(
  model: string,
  messages: LlmMessage[],
): Promise<ModelTextMessage> {
  const provider = getConfiguredProvider();
  const extraBody = getProviderExtraBody(provider);
  const response = await createModelClient(provider).chat.completions.create({
    model,
    messages,
    ...(extraBody ? { extra_body: extraBody } : {}),
  } as never);

  const message = response.choices[0]?.message;
  const content = getMessageTextContent(message?.content);
  const reasoningContent = getReasoningContent(message);

  return {
    content: content || "I reached the model, but it did not return usable text.",
    reasoning_content: reasoningContent,
  };
}

export async function callModelForToolDecision(
  model: string,
  messages: LlmMessage[],
  allowedToolNames?: string[],
): Promise<ModelToolMessage> {
  const provider = getConfiguredProvider();
  const extraBody = getProviderExtraBody(provider);
  const response = await createModelClient(provider).chat.completions.create({
    model,
    messages,
    tools: buildModelTools(allowedToolNames),
    tool_choice: "auto",
    ...(extraBody ? { extra_body: extraBody } : {}),
  } as never);

  const message = response.choices[0]?.message;
  const firstToolCall = message?.tool_calls?.[0];
  const content = getMessageTextContent(message?.content) || null;
  const reasoningContent = getReasoningContent(message);
  const assistantMessage: LlmMessage = {
    role: "assistant",
    content: message?.content ?? null,
    reasoning_content: reasoningContent,
    tool_calls:
      firstToolCall?.type === "function"
        ? [
            {
              id: firstToolCall.id || createSyntheticToolCallId(),
              type: "function",
              function: {
                name: firstToolCall.function.name,
                arguments: firstToolCall.function.arguments,
              },
            },
          ]
        : undefined,
  };

  if (firstToolCall?.type !== "function") {
    return {
      assistantMessage,
      content,
      toolCall: null,
    };
  }

  const parsedArguments = parseToolCallArguments(firstToolCall.function.arguments);
  if (!parsedArguments) {
    return {
      assistantMessage,
      content,
      toolCall: null,
    };
  }

  return {
    assistantMessage,
    content,
    toolCall: {
      id: assistantMessage.tool_calls?.[0]?.id || createSyntheticToolCallId(),
      name: firstToolCall.function.name,
      input: parsedArguments,
    },
  };
}
