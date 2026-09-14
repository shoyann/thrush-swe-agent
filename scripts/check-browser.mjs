import { createRequire } from "node:module";
import path from "node:path";
const resources = process.env.THRUSH_RESOURCE_DIR || process.cwd();
const require = createRequire(path.join(resources, "package.json"));
let browser;
try {
  browser = await require("playwright").chromium.launch({
    headless: true,
    timeout: 12000,
  });
  const page = await browser.newPage();
  await page.setContent("<title>Thrush browser check</title>");
  if ((await page.title()) !== "Thrush browser check")
    throw new Error("Browser page check failed.");
  console.log(
    JSON.stringify({ ok: true, message: "Chromium launches successfully." }),
  );
} catch (error) {
  const details = String(error.message);
  const missing = details.match(
    /error while loading shared libraries: ([^:]+):/,
  );
  const message = missing
    ? "Ubuntu is missing browser system libraries (" +
      missing[1] +
      "). Install Playwright's Chromium system dependencies in this distribution, then Recheck."
    : /Executable doesn't exist/.test(details)
      ? "Prepare the browser runtime to enable web tools."
      : "Chromium cannot launch. " +
        details.split("\n").slice(0, 2).join(" ").slice(0, 350);
  console.log(JSON.stringify({ ok: false, message }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
