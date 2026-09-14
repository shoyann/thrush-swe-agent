"use client";
import { useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        className="copy-button"
        aria-label="Copy code"
        onClick={async (e) => {
          const text =
            e.currentTarget.parentElement?.querySelector("pre")?.textContent ||
            "";
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre {...props}>{children}</pre>
    </div>
  );
}
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt || "Image"}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
export function DiffView({ text }: { text: string }) {
  let oldLine = 0,
    newLine = 0;
  return (
    <div className="diff-view">
      {text.split("\n").map((line, index) => {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          oldLine = Number(hunk[1]);
          newLine = Number(hunk[2]);
        }
        const meta =
          /^(diff |index |--- |\+\+\+ |@@|new file|deleted file|Binary|\\)/.test(
            line,
          );
        const kind = meta
          ? "meta"
          : line.startsWith("+")
            ? "added"
            : line.startsWith("-")
              ? "removed"
              : "context";
        const before = !meta && kind !== "added" ? oldLine++ : "";
        const after = !meta && kind !== "removed" ? newLine++ : "";
        return (
          <div className={"diff-line " + kind} key={index}>
            <span>{before || ""}</span>
            <span>{after || ""}</span>
            <code>{line || " "}</code>
          </div>
        );
      })}
    </div>
  );
}
