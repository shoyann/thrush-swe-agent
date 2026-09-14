"use client";
import { useEffect, useRef } from "react";
import { ArrowUp, LoaderCircle, ShieldCheck } from "lucide-react";
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  working,
  mode,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  working: boolean;
  mode: "assist" | "auto";
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 180) + "px";
    }
  }, [value]);
  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled && !working && value.trim()) onSubmit();
        }}
      >
        <textarea
          ref={textarea}
          aria-label="Describe your task"
          rows={2}
          value={value}
          disabled={working}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            mode === "assist"
              ? "Ask Thrush to build, fix, or explore…"
              : "Give Thrush a task to work through independently…"
          }
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!disabled && !working && value.trim()) onSubmit();
            }
          }}
        />
        <div className="composer-footer">
          <span>
            <ShieldCheck size={14} />
            {mode === "assist"
              ? "Changes need your approval"
              : "Runs in an isolated worktree"}
          </span>
          <button
            className="send-button"
            type="submit"
            aria-label={mode === "assist" ? "Send task" : "Start Auto"}
            disabled={disabled || working || !value.trim()}
          >
            {working ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <ArrowUp size={20} />
            )}
          </button>
        </div>
      </form>
      <p className="composer-hint">
        Enter to send <span>·</span> Shift + Enter for a new line
      </p>
    </div>
  );
}
