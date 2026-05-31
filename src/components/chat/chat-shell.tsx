"use client";

import Image from "next/image";
import { FormEvent, useLayoutEffect, useRef, useState } from "react";
import type {
  AgentRequest,
  AgentSessionContext,
  AgentStep,
  AgentStreamEvent,
  ChatMessage,
} from "@/types/agent";

const starterMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "I am Thrush. Give me a task and I will show how the loop will work.",
  },
];

const starterSteps: AgentStep[] = [
  {
    id: "waiting",
    title: "Waiting for a task",
    detail: "The agent is idle until you send a message.",
    status: "idle",
  },
];

const loadingSteps: AgentStep[] = [
  {
    id: "perceive",
    title: "Perceive",
    detail: "Send the task to the backend API.",
    status: "running",
  },
  {
    id: "think",
    title: "Think",
    detail: "Wait for the backend agent loop to prepare a reply.",
    status: "idle",
  },
  {
    id: "act",
    title: "Act",
    detail: "The backend will answer here after it finishes.",
    status: "idle",
  },
];

const MAX_CONTEXT_MESSAGES = 8;
const thinkingFragments = ["top", "right", "bottom", "left"] as const;
const agentApiSecret = process.env.NEXT_PUBLIC_AGENT_API_SECRET?.trim();

type AgentErrorEvent = {
  type: "error";
  message: string;
};

async function readBackendErrorMessage(response: Response) {
  const fallbackMessage = `The backend API returned HTTP ${response.status}.`;

  try {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { error?: unknown };
      return typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : fallbackMessage;
    }

    const text = (await response.text()).trim();
    return text || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function getRequestFailureMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "The request failed for an unknown reason.";
}

function parseStreamEvent(rawChunk: string) {
  const dataLine = rawChunk
    .split("\n")
    .find((line) => line.startsWith("data: "));

  if (!dataLine) {
    return null;
  }

  const payload = dataLine.slice("data: ".length).trim();
  if (!payload) {
    return null;
  }

  return JSON.parse(payload) as AgentStreamEvent | AgentErrorEvent;
}

export function ChatShell() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(starterMessages);
  const [sessionContext, setSessionContext] = useState<AgentSessionContext>({});
  const [steps, setSteps] = useState<AgentStep[]>(starterSteps);
  const [isLoading, setIsLoading] = useState(false);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const pendingDraft = sessionContext.pendingDraft;

  useLayoutEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  function applyStreamEvent(event: AgentStreamEvent | AgentErrorEvent) {
    if (event.type === "steps") {
      setSteps(event.steps);
      return;
    }

    if (event.type === "message") {
      setMessages((current) => [...current, event.message]);
      return;
    }

    if (event.type === "done") {
      setSessionContext(event.sessionContext);
      return;
    }

    throw new Error(event.message);
  }

  async function readAgentStream(response: Response) {
    if (!response.body) {
      throw new Error("The backend did not open a readable stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const event = parseStreamEvent(chunk);

        if (!event) {
          continue;
        }

        applyStreamEvent(event);
      }
    }

    const finalChunk = buffer.trim();
    if (!finalChunk) {
      return;
    }

    const finalEvent = parseStreamEvent(finalChunk);
    if (finalEvent) {
      applyStreamEvent(finalEvent);
    }
  }

  async function submitTask(task: string, displayTask = task) {
    const cleanTask = task.trim();
    const cleanDisplayTask = displayTask.trim();
    if (!cleanTask || !cleanDisplayTask || isLoading) {
      return;
    }

    const timestamp = Date.now();
    const userMessage: ChatMessage = {
      id: `user-${timestamp}`,
      role: "user",
      content: cleanDisplayTask,
    };

    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setSteps(loadingSteps);
    setInput("");

    setIsLoading(true);

    try {
      const payload: AgentRequest = {
        task: cleanTask,
        messages: nextMessages.slice(-MAX_CONTEXT_MESSAGES),
        sessionContext,
        stream: true,
      };
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(agentApiSecret
            ? { Authorization: `Bearer ${agentApiSecret}` }
            : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(await readBackendErrorMessage(response));
      }

      await readAgentStream(response);
    } catch (error) {
      const errorMessage = getRequestFailureMessage(error);

      setMessages((current) => [
        ...current,
        {
          id: `assistant-error-${Date.now()}`,
          role: "assistant",
          content:
            [
              "The request failed.",
              errorMessage,
            ].join("\n"),
        },
      ]);
      setSteps([
        {
          id: "perceive",
          title: "Perceive",
          detail: `Tried to send the task "${cleanDisplayTask}" to the backend API.`,
          status: "done",
        },
        {
          id: "think",
          title: "Think",
          detail: `The request failed with this reason: ${errorMessage}`,
          status: "done",
        },
        {
          id: "act",
          title: "Act",
          detail: "Show an error message in the chat window.",
          status: "done",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitTask(input);
  }

  async function handleDraftDecision(decision: "approve" | "cancel") {
    if (!pendingDraft) {
      return;
    }

    const task =
      decision === "approve"
        ? `APPROVE_WRITE ${pendingDraft.id}`
        : `CANCEL_WRITE ${pendingDraft.id}`;
    const displayTask = decision === "approve" ? "YES" : "NO";

    await submitTask(task, displayTask);
  }

  return (
    <main className="app-shell">
      <header className="brand-bar" aria-label="Thrush brand">
        <div className="brand-mark-wrap">
          <Image
            src="/icon.png"
            alt="Thrush icon"
            width={44}
            height={44}
            className="brand-mark"
            priority
          />
        </div>
        <div className="brand-copy">
          <p className="brand-name">Thrush</p>
          <p className="brand-tagline">Agent workspace</p>
        </div>
      </header>

      <section className="workspace-grid">
        <div className="panel chat-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Chat</p>
              <h2>Task feed</h2>
            </div>
          </div>

          <div ref={messageViewportRef} className="message-viewport">
            <div className="message-list">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`message-bubble ${message.role}`}
                >
                  <p className="message-role">{message.role}</p>
                  <p>{message.content}</p>
                </article>
              ))}

              {isLoading ? (
                <article className="message-bubble assistant thinking-bubble">
                  <p className="message-role">assistant</p>
                  <div className="thinking-shell" aria-label="Thrush is thinking">
                    <div className="thinking-prism-container">
                      {thinkingFragments.map((fragment) => (
                        <span
                          key={fragment}
                          className={`prism-fragment ${fragment}`}
                        />
                      ))}
                    </div>
                    <div className="thinking-copy">
                      <strong>Thinking</strong>
                      <span>Gathering context and shaping the next step.</span>
                    </div>
                  </div>
                </article>
              ) : null}
            </div>
          </div>

          {pendingDraft ? (
            <div className="draft-decision-panel">
              <p className="draft-decision-copy">
                Pending draft for <strong>{pendingDraft.path}</strong>
              </p>
              <div className="draft-decision-row">
                <button
                  className="decision-button yes"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleDraftDecision("approve")}
                >
                  YES
                </button>
                <button
                  className="decision-button no"
                  type="button"
                  disabled={isLoading}
                  onClick={() => void handleDraftDecision("cancel")}
                >
                  NO
                </button>
              </div>
            </div>
          ) : null}

          <form className="composer" onSubmit={handleSubmit}>
            <label className="composer-label" htmlFor="task-input">
              Describe the task you want the agent to do
            </label>
            <div className="composer-row">
              <textarea
                id="task-input"
                className="composer-input"
                rows={3}
                disabled={isLoading}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Example: read the README, then suggest the first 3 files I should create."
              />
              <button className="composer-button" type="submit" disabled={isLoading}>
                {isLoading ? "Sending..." : "Send task"}
              </button>
            </div>
          </form>
        </div>

        <aside className="panel trace-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Agent Trace</p>
              <h2>{"Perceive -> Think -> Act"}</h2>
            </div>
          </div>

          <div className="step-list">
            {steps.map((step) => (
              <article
                key={step.id}
                className={`step-card ${step.status}`}
              >
                <div className="step-card-content">
                  <div className="step-topline">
                    <h3>{step.title}</h3>
                    <span className={`step-status ${step.status}`}>
                      {step.status === "running" ? (
                        <span className="badge-node-container" aria-hidden="true">
                          <span className="badge-node" />
                          <span className="badge-node" />
                          <span className="badge-node" />
                        </span>
                      ) : (
                        <span className="step-status-dot" aria-hidden="true" />
                      )}
                      {step.status}
                    </span>
                  </div>
                  <p>{step.detail}</p>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
