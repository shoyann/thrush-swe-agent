import { _electron as electron, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
mkdirSync("test-results/desktop", { recursive: true });
for (const scale of [1, 2]) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "thrush-dpi-"));
  const application = await electron.launch({ args: [process.cwd(), "--force-device-scale-factor=" + scale], env: { ...process.env, THRUSH_TEST_PROFILE: profile } });
  try {
    const page = await application.firstWindow();
    await page.waitForURL("thrush://app/", { timeout: 100000 });
    await expect(page.getByRole("dialog", { name: "Set up your workspace" })).toBeVisible();
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(scale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: "test-results/desktop/11-dpi-" + scale + ".png" });
  } finally { await application.close(); }
}
console.log(JSON.stringify({status:"passed",checks:["100% DPI","200% DPI","setup layout without horizontal overflow"]}));
