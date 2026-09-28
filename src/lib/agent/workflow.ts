/** Durable Assist state. Keep policy here, independent of models, tools and UI. */
export type WorkflowStatus =
  | "running"
  | "awaiting_approval"
  | "paused"
  | "blocked"
  | "unverified"
  | "completed"
  | "cancelled";
export type WorkflowPlan = {
  kind: "change" | "inspect";
  steps: string[];
  checks: string[];
  verificationNote: string;
};
export type WorkflowState = {
  version: 1;
  id: string;
  objective: string;
  workspace: string;
  status: WorkflowStatus;
  plan: WorkflowPlan | null;
  revision: number;
  changedFiles: string[];
  checks: Record<string, { revision: number; ok: boolean }>;
  journal: string[];
  reason: string | null;
  inFlight: string | null;
  updatedAt: number;
};

export function normalizeWorkflow(value: unknown): WorkflowState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as WorkflowState;
  if (
    v.version !== 1 ||
    typeof v.id !== "string" ||
    typeof v.objective !== "string" ||
    typeof v.workspace !== "string" ||
    ![
      "running",
      "awaiting_approval",
      "paused",
      "blocked",
      "unverified",
      "completed",
      "cancelled",
    ].includes(v.status) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !Array.isArray(v.changedFiles) ||
    !v.changedFiles.every((p) => typeof p === "string") ||
    !Array.isArray(v.journal) ||
    !v.journal.every((p) => typeof p === "string") ||
    !v.checks ||
    typeof v.checks !== "object"
  )
    return null;
  if (
    v.plan &&
    (!["change", "inspect"].includes(v.plan.kind) ||
      !Array.isArray(v.plan.steps) ||
      !v.plan.steps.every((s) => typeof s === "string") ||
      !Array.isArray(v.plan.checks) ||
      !v.plan.checks.every((s) => typeof s === "string") ||
      typeof v.plan.verificationNote !== "string")
  )
    return null;
  if (
    !Object.values(v.checks).every(
      (c) => c && Number.isSafeInteger(c.revision) && typeof c.ok === "boolean",
    )
  )
    return null;
  return structuredClone(v);
}

export function newWorkflow(
  objective: string,
  workspace: string,
): WorkflowState {
  return {
    version: 1,
    id: crypto.randomUUID(),
    objective,
    workspace,
    status: "running",
    plan: null,
    revision: 0,
    changedFiles: [],
    checks: {},
    journal: [],
    reason: null,
    inFlight: null,
    updatedAt: Date.now(),
  };
}

export function remember(state: WorkflowState, event: string) {
  state.journal = [...state.journal, event.slice(0, 3000)].slice(-24);
  state.updatedAt = Date.now();
}

export function recordWrite(state: WorkflowState, file: string) {
  state.revision += 1;
  if (!state.changedFiles.includes(file)) state.changedFiles.push(file);
  // Any edit makes all earlier checks stale, including checks from earlier turns.
  state.checks = {};
  remember(state, `Applied file write: ${file}. Verification must run again.`);
}

export function completionProblem(
  state: WorkflowState,
  hasDraft: boolean,
  allowUnverified = false,
): string | null {
  if (hasDraft)
    return "A draft still needs approval; it is not an applied change.";
  if (!state.plan) return "Call task_plan before claiming task completion.";
  if (state.plan.kind === "change" && state.changedFiles.length === 0)
    return "This is a change task but no file changes were applied. Continue implementing, or finish as blocked with the actual reason.";
  if (allowUnverified) return null;
  const missing = state.plan.checks.filter((command) => {
    const check = state.checks[command];
    return !check?.ok || check.revision !== state.revision;
  });
  if (missing.length)
    return `Required checks have not passed after the latest edit: ${missing.join(", ")}. Inspect failures, fix and rerun.`;
  if (state.plan.kind === "change" && !state.plan.checks.length)
    return "No verification has been recorded. Run the required project checks, or explicitly finish as unverified with the missing verification explained.";
  return null;
}

export function isContinueRequest(task: string) {
  return /^(?:(?:please\s+)?(?:continue|resume)(?:\s|$)|(?:请)?(?:继续|接着))/iu.test(
    task.trim(),
  );
}

export function isUnfinished(state: WorkflowState | null | undefined) {
  return (
    !!state && state.status !== "completed" && state.status !== "cancelled"
  );
}

export function positiveLimit(
  value: string | undefined,
  fallback: number,
  maximum: number,
) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, maximum) : fallback;
}
