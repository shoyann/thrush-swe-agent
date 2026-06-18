import type {
  AutoReadinessCheck,
  MiniPresetConfig,
} from "../../types/auto";

export type CommandResult = {
  stderr: string;
  stdout: string;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<CommandResult>;

function errorText(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "Unknown error.";
}

function isWslRuntime() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function getProvider() {
  return process.env.MODEL_PROVIDER?.trim().toLowerCase() || "deepseek";
}

export function getModelKeyRequirement(modelName: string | null) {
  const provider = getProvider();
  const normalizedModel = modelName?.toLowerCase() ?? "";

  if (normalizedModel.startsWith("openrouter/")) {
    return {
      envName: "OPENROUTER_API_KEY",
      label: "OpenRouter",
    };
  }

  if (provider === "openai" || normalizedModel.startsWith("openai/")) {
    return {
      envName: "OPENAI_API_KEY",
      label: "OpenAI",
    };
  }

  if (
    provider === "anthropic" ||
    normalizedModel.includes("anthropic") ||
    normalizedModel.includes("claude") ||
    normalizedModel.includes("sonnet") ||
    normalizedModel.includes("opus")
  ) {
    return {
      envName: "ANTHROPIC_API_KEY",
      label: "Anthropic",
    };
  }

  return {
    envName: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
  };
}

export function modelCheck(snapshot: MiniPresetConfig): AutoReadinessCheck {
  const provider = getProvider();

  if (!["anthropic", "deepseek", "openai"].includes(provider)) {
    return {
      category: "model_config_missing",
      message:
        'MODEL_PROVIDER must be one of "deepseek", "openai", or "anthropic".',
      name: "model",
      ok: false,
      required: true,
    };
  }

  const modelName = snapshot.modelName ?? null;
  const requirement = getModelKeyRequirement(modelName);

  if (!process.env[requirement.envName]?.trim()) {
    return {
      category: "model_config_missing",
      message: `Missing ${requirement.envName}. Auto needs a ${requirement.label} API key before mini-swe-agent can run.`,
      name: "model",
      ok: false,
      required: true,
    };
  }

  return {
    message: `Model configuration is ready for ${modelName ?? requirement.label}.`,
    name: "model",
    ok: true,
    required: true,
  };
}

export async function gitCheck(
  workspacePath: string,
  runCommand: CommandRunner,
): Promise<AutoReadinessCheck> {
  try {
    const status = await runCommand("git", ["status", "--porcelain"], {
      cwd: workspacePath,
    });

    if (status.stdout.trim()) {
      return {
        category: "workspace_dirty",
        message:
          "Your main project has uncommitted changes. Commit or stash them before starting Auto so the result stays separate from your work.",
        name: "git",
        ok: false,
        required: true,
      };
    }

    return {
      message: "Git workspace is clean.",
      name: "git",
      ok: true,
      required: true,
    };
  } catch (error) {
    return {
      category: "workspace_dirty",
      message: `Thrush could not inspect Git status for this project. ${errorText(error)}`,
      name: "git",
      ok: false,
      required: true,
    };
  }
}

export async function dockerCheck(
  snapshot: MiniPresetConfig,
  runCommand: CommandRunner,
): Promise<AutoReadinessCheck> {
  if ((snapshot.environment ?? "docker") !== "docker") {
    return {
      message:
        "This Mini Preset uses local execution, so Docker is not required for this run.",
      name: "docker",
      ok: true,
      required: false,
    };
  }

  try {
    await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 12_000,
    });

    return {
      message: `Docker is ready. Auto will use ${snapshot.dockerImage ?? "the recommended Docker image"}.`,
      name: "docker",
      ok: true,
      required: true,
    };
  } catch (error) {
    const wslHint = isWslRuntime()
      ? " If Docker Desktop is already installed on Windows, open Docker Desktop Settings -> Resources -> WSL Integration and enable Ubuntu."
      : "";

    return {
      category: "docker_unavailable",
      message: `Docker is not available in this runtime.${wslHint} Details: ${errorText(error)}`,
      name: "docker",
      ok: false,
      required: true,
    };
  }
}
