import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

function resolveWindowsChromiumExecutablePath() {
  const userProfile = process.env.USERPROFILE?.trim();

  if (!userProfile) {
    return null;
  }

  const browsersRoot = path.join(userProfile, "AppData", "Local", "ms-playwright");

  if (!existsSync(browsersRoot)) {
    return null;
  }

  const candidatePaths = readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map((entry) =>
      path.join(browsersRoot, entry.name, "chrome-win64", "chrome.exe"),
    )
    .filter((candidatePath) => existsSync(candidatePath));

  return candidatePaths[0] ?? null;
}

function isMissingHeadlessShellError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return /Executable doesn't exist[\s\S]*chrome-headless-shell/i.test(message);
}

export async function launchPlaywrightChromium() {
  try {
    return await chromium.launch({
      headless: true,
    });
  } catch (error) {
    if (!isMissingHeadlessShellError(error)) {
      throw error;
    }

    const fallbackExecutablePath = resolveWindowsChromiumExecutablePath();

    if (!fallbackExecutablePath) {
      throw error;
    }

    return chromium.launch({
      headless: true,
      executablePath: fallbackExecutablePath,
    });
  }
}
