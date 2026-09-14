// Use Windows' network stack for large downloads, including its system networking settings.
// Browser revisions and download locations come from the pinned Playwright CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
const resources = process.env.THRUSH_RESOURCE_DIR || process.cwd();
const runtime =
  process.env.THRUSH_RUNTIME_DIR || path.join(process.cwd(), "data");
const browserRoot = path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
const plan = execFileSync(
  process.execPath,
  [
    path.join(resources, "node_modules/playwright/cli.js"),
    "install",
    "--dry-run",
    "--only-shell",
    "chromium",
  ],
  { encoding: "utf8", windowsHide: true },
);
const entries = new Map(
  [
    ...plan.matchAll(
      /Install location:\s*([^\r\n]+)[\s\S]*?Download url:\s*(https:\/\/[^\r\n]+)/g,
    ),
  ].map((match) => [match[1].trim(), match[2].trim()]),
);
if (entries.size < 2)
  throw new Error("Cannot read the bundled browser installation manifest.");
const downloads = path.join(runtime, "downloads");
mkdirSync(downloads, { recursive: true });
for (const [directory, url] of entries) {
  const target = path.resolve(directory);
  if (
    !target.startsWith(browserRoot + path.sep) ||
    new URL(url).hostname !== "cdn.playwright.dev"
  )
    throw new Error("Unexpected browser installation destination.");
  const marker = path.join(target, "INSTALLATION_COMPLETE");
  if (existsSync(marker)) continue;
  const archive = path.join(downloads, path.basename(target) + ".zip");
  console.log("Downloading " + path.basename(target) + "…");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:THRUSH_DOWNLOAD_URL -OutFile $env:THRUSH_DOWNLOAD_FILE -TimeoutSec 180 -ErrorAction Stop",
    ],
    {
      stdio: "inherit",
      windowsHide: true,
      timeout: 200000,
      env: {
        ...process.env,
        THRUSH_DOWNLOAD_URL: url,
        THRUSH_DOWNLOAD_FILE: archive,
      },
    },
  );
  mkdirSync(target, { recursive: true });
  const extract =
    "import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[2]).resolve()\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for name in z.namelist():\n  if not (root/name).resolve().is_relative_to(root): raise ValueError('Invalid archive path')\n z.extractall(root)";
  execFileSync(
    path.join(runtime, "mini-venv/Scripts/python.exe"),
    ["-c", extract, archive, target],
    { stdio: "inherit", windowsHide: true, timeout: 120000 },
  );
  writeFileSync(marker, "");
  unlinkSync(archive);
}
console.log("Browser downloads complete.");
