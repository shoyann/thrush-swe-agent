import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const vendorDir = path.join(root, "vendor", "mini-swe-agent");
const venvDir = path.join(root, "data", "mini-venv");
const readyPath = path.join(venvDir, ".ready.json");
const requirementsPath = path.join(root, "scripts", "mini-runtime-requirements.txt");
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  return result.status === 0;
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  return result.status === 0 ? result.stdout.trim() : "";
}

function findUv() {
  const configuredUv = process.env.UV_PATH?.trim();
  if (configuredUv && existsSync(configuredUv)) {
    return configuredUv;
  }

  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    home ? path.join(home, ".local", "bin", "uv") : "",
    home ? path.join(home, ".local", "bin", "uv.exe") : "",
    path.join(root, "data", "uv", "uv"),
    path.join(root, "data", "uv", "uv.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? "uv";
}

function hasModule(pythonPath, moduleName) {
  const result = spawnSync(pythonPath, ["-c", `import ${moduleName}`], {
    stdio: "ignore",
  });

  return result.status === 0;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function tryRunWithTimeout(command, args, options = {}) {
  const usePosixTimeout = process.platform !== "win32";
  const finalCommand = usePosixTimeout ? "timeout" : command;
  const finalArgs = usePosixTimeout
    ? ["--kill-after=5s", "180s", command, ...args]
    : args;
  const result = spawnSync(finalCommand, finalArgs, {
    stdio: "inherit",
    timeout: 180_000,
    ...options,
  });

  return result.status === 0;
}

function installRequirement({ env, pip, requirement, uv, venvPython }) {
  const uvArgs = ["pip", "install", "--python", venvPython, requirement];
  const pipArgs = [
    "install",
    "--retries",
    "3",
    "--timeout",
    "45",
    requirement,
  ];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (tryRunWithTimeout(uv, uvArgs, { env })) {
      return;
    }

    if (tryRunWithTimeout(pip, pipArgs, { env })) {
      return;
    }

    console.log(`Retrying Python dependency (${attempt}/3): ${requirement}`);
  }

  console.error(`Could not install Python dependency: ${requirement}`);
  process.exit(1);
}

function installEditableMini({ env, pip, uv, venvPython, vendorDir }) {
  if (tryRunWithTimeout(uv, ["pip", "install", "--python", venvPython, "-e", vendorDir], { env })) {
    return;
  }

  run(pip, ["install", "-e", vendorDir], { env, timeout: 180_000 });
}

if (!existsSync(vendorDir)) {
  console.error(
    [
      "Bundled mini-swe-agent was not found.",
      `Expected: ${vendorDir}`,
      "",
      "Add it as a submodule or checkout first:",
      "  git submodule add https://github.com/SWE-agent/mini-swe-agent.git vendor/mini-swe-agent",
      "  git submodule update --init --recursive",
    ].join("\n"),
  );
  process.exit(1);
}

if (!existsSync(requirementsPath)) {
  console.error(`Mini runtime requirements file was not found: ${requirementsPath}`);
  process.exit(1);
}

mkdirSync(path.dirname(venvDir), { recursive: true });

if (!existsSync(venvDir)) {
  if (!tryRun(python, ["-m", "venv", venvDir])) {
    run(findUv(), ["venv", "--seed", "--python", python, venvDir]);
  }
}

const pip =
  process.platform === "win32"
    ? path.join(venvDir, "Scripts", "pip.exe")
    : path.join(venvDir, "bin", "pip");
const venvPython =
  process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");

const env = {
  ...process.env,
  PIP_CACHE_DIR: process.env.PIP_CACHE_DIR || path.join(root, "data", "pip-cache"),
  PIP_DISABLE_PIP_VERSION_CHECK: process.env.PIP_DISABLE_PIP_VERSION_CHECK || "1",
  UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(root, "data", "uv-cache"),
  UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || "300",
};
const uv = findUv();

if (!hasModule(venvPython, "pip")) {
  const repaired = tryRun(venvPython, ["-m", "ensurepip", "--upgrade"], { env });

  if (!repaired || !hasModule(venvPython, "pip")) {
    console.log("Existing mini venv has no pip; rebuilding it with uv --seed.");
    rmSync(venvDir, { force: true, recursive: true });
    run(findUv(), ["venv", "--seed", "--python", python, venvDir], { env });
  }
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { env });
const requirementsText = readFileSync(requirementsPath, "utf8");
for (const requirement of requirementsText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))) {
  installRequirement({ env, pip, requirement, uv, venvPython });
}
installEditableMini({ env, pip, uv, vendorDir, venvPython });

run(venvPython, [
  "-c",
  [
    "import litellm, openai, minisweagent",
    "print('mini runtime import check passed')",
  ].join("; "),
]);

const vendorCommit = output("git", ["-C", vendorDir, "rev-parse", "HEAD"]);
const pythonVersion = output(venvPython, ["--version"]);
const metadata = {
  createdAt: new Date().toISOString(),
  pythonVersion,
  requirementsSha256: sha256(requirementsText),
  vendorCommit: vendorCommit || null,
};

writeFileSync(readyPath, `${JSON.stringify(metadata, null, 2)}\n`);

console.log(`mini-swe-agent bootstrap complete: ${readyPath}`);
