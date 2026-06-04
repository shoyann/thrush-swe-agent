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

function createModelClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    throw new Error("Missing DEEPSEEK_API_KEY.");
  }

  return new OpenAI({
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
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
  const response = await createModelClient().chat.completions.create({
    model,
    messages,
    extra_body: {
      thinking: {
        type: "disabled",
      },
    },
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
  const response = await createModelClient().chat.completions.create({
    model,
    messages,
    tools: buildModelTools(allowedToolNames),
    tool_choice: "auto",
    extra_body: {
      thinking: {
        type: "disabled",
      },
    },
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
