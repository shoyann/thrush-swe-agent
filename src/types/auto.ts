export type AutoRunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "reporting"
  | "completed"
  | "failed"
  | "canceled";

export type AutoArtifactType =
  | "changed_files"
  | "diff"
  | "diff_stat"
  | "draft_pr"
  | "logs"
  | "patch"
  | "report"
  | "test_output"
  | "trajectory";

export type AutoFailureCategory =
  | "canceled"
  | "cost_limit"
  | "dependency_install_failed"
  | "docker_start_failed"
  | "docker_unavailable"
  | "github_auth_missing"
  | "github_pr_failed"
  | "github_push_failed"
  | "github_unavailable"
  | "mini_unavailable"
  | "mini_failed"
  | "model_config_missing"
  | "repeated_format_error"
  | "report_failed"
  | "timeout"
  | "unknown"
  | "workspace_dirty";

export type AutoMiniExitStatus =
  | "Submitted"
  | "LimitsExceeded"
  | "TimeExceeded"
  | "RepeatedFormatError"
  | "Error"
  | "Unknown";

export type AutoReadinessCheckName =
  | "docker"
  | "github"
  | "git"
  | "mini"
  | "model"
  | "runtime";

export type AutoReadinessCheck = {
  category?: AutoFailureCategory;
  message: string;
  name: AutoReadinessCheckName;
  ok: boolean;
  required: boolean;
};

export type RecommendedEnvironmentKind = "generic" | "node" | "python" | "rust";

export type RecommendedEnvironment = {
  dockerImage: string;
  kind: RecommendedEnvironmentKind;
  reason: string;
};

export type MiniPresetConfig = {
  advancedConfig?: Record<string, unknown>;
  costLimit?: number;
  dockerImage?: string;
  environment?: "docker" | "local";
  environmentKind?: RecommendedEnvironmentKind;
  modelName?: string;
  networkPolicy?: "default" | "none";
  stepLimit?: number;
  wallTimeLimitSeconds?: number;
};

export type AutoReadiness = {
  canCreateRun: boolean;
  checks: AutoReadinessCheck[];
  dockerImage: string | null;
  environment: MiniPresetConfig["environment"];
  environmentKind: RecommendedEnvironmentKind | null;
  message: string;
  modelName: string | null;
};

export type MiniPreset = {
  config: MiniPresetConfig;
  createdAt: number;
  description: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  projectId: string | null;
  updatedAt: number;
};

export type AutoRun = {
  attemptGroupId: string | null;
  baseCommitSha: string | null;
  branchName: string | null;
  cancelRequested: boolean;
  createdAt: number;
  diffArtifactId: string | null;
  draftPrUrl: string | null;
  exitCode: number | null;
  failureCategory: AutoFailureCategory | null;
  failureMessage: string | null;
  finishedAt: number | null;
  headCommitSha: string | null;
  id: string;
  presetId: string | null;
  presetSnapshot: MiniPresetConfig;
  projectId: string;
  reportArtifactId: string | null;
  resultStatus: string | null;
  sourceRunId: string | null;
  sourceSessionId: string | null;
  startedAt: number | null;
  status: AutoRunStatus;
  task: string;
  updatedAt: number;
  workspacePath: string;
  worktreePath: string | null;
};

export type AutoEvent = {
  autoRunId: string;
  createdAt: number;
  data: Record<string, unknown>;
  id: string;
  message: string;
  type: string;
};

export type AutoArtifact = {
  autoRunId: string;
  contentText: string | null;
  createdAt: number;
  filePath: string | null;
  id: string;
  label: string;
  metadata: Record<string, unknown>;
  type: AutoArtifactType;
};

export type AutoRunDetail = {
  artifacts: AutoArtifact[];
  events: AutoEvent[];
  run: AutoRun;
};

export type AutoRunCreateRequest = {
  presetId?: string;
  projectId: string;
  sourceRunId?: string;
  sourceSessionId?: string;
  task: string;
};

export type AutoRunCancelRequest = {
  reason?: string;
};
