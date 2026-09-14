import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const resources = process.env.THRUSH_RESOURCE_DIR || process.cwd();
const runtime =
  process.env.THRUSH_RUNTIME_DIR || path.join(process.cwd(), "data");
const uv = path.join(
  resources,
  "tools",
  process.platform === "win32" ? "uv.exe" : "uv",
);
const venv = path.join(runtime, "mini-venv");
const python = path.join(
  venv,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
process.env.PYTHONUTF8 = "1";
process.env.PYTHONIOENCODING = "utf-8";
process.env.MSWEA_GLOBAL_CONFIG_DIR = path.join(runtime, "mini-config");
if (
  process.platform === "linux" &&
  /VERSION_ID="26.04"/.test(readFileSync("/etc/os-release", "utf8"))
)
  process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu24.04-x64";
const miniSource = path.join(runtime, "sources", "mini-swe-agent");
mkdirSync(path.dirname(miniSource), { recursive: true });
cpSync(path.join(resources, "vendor", "mini-swe-agent"), miniSource, {
  recursive: true,
  filter: (source) => ![".git", "__pycache__"].includes(path.basename(source)),
});
const requirements = path.join(
  resources,
  "scripts",
  "mini-runtime-requirements.txt",
);
mkdirSync(runtime, { recursive: true });
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        UV_PYTHON_INSTALL_DIR: path.join(runtime, "python"),
        UV_CACHE_DIR: path.join(runtime, "uv-cache"),
        UV_HTTP_TIMEOUT: "120",
      },
    });
    // A stalled dependency download must return control to the setup retry UI.
    const timer = setTimeout(
      () => {
        if (process.platform === "win32")
          spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else child.kill("SIGTERM");
        reject(
          new Error(
            "Dependency download timed out. Check your connection and retry.",
          ),
        );
      },
      10 * 60 * 1000,
    );
    child.on("close", () => clearTimeout(timer));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Dependency command failed with code " + code)),
    );
  });
}
try {
  console.log("1/4 Preparing a private Python 3.12 runtime…");
  await run(uv, [
    "venv",
    "--python",
    "3.12.13",
    "--managed-python",
    "--allow-existing",
    venv,
  ]);
  console.log("2/4 Installing Agent dependencies…");
  await run(uv, [
    "pip",
    "install",
    "--python",
    python,
    "-r",
    path.join(resources, "scripts", "mini-runtime.lock"),
  ]);
  await run(uv, [
    "pip",
    "install",
    "--python",
    python,
    "--no-deps",
    miniSource,
  ]);
  console.log("3/4 Verifying Agent runtime…");
  await run(python, ["-c", "import litellm, openai, minisweagent"]);
  writeFileSync(
    path.join(venv, ".ready.json"),
    JSON.stringify({
      requirementsSha256: createHash("sha256")
        .update(readFileSync(requirements))
        .digest("hex"),
    }),
  );
  console.log("4/4 Installing browser tools…");
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(runtime, "browsers");
  if (process.platform === "win32") {
    await run(process.execPath, [
      path.join(resources, "scripts", "install-windows-browsers.mjs"),
    ]);
  } else {
    await run(process.execPath, [
      path.join(resources, "node_modules", "playwright", "cli.js"),
      "install",
      "chromium",
      "--only-shell",
    ]);
  }
  await run(process.execPath, [
    path.join(resources, "scripts", "check-browser.mjs"),
  ]);
  console.log(
    "Runtime is ready. Docker, Git and project-specific tools are checked separately.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
