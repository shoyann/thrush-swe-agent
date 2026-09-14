const fs = require("node:fs");
const path = require("node:path");
module.exports = async function verifyPackage(context) {
  const resources = path.join(context.appOutDir, "resources", "runtime");
  const root = path.join(resources, "windows");
  for (const file of [
    "server.js",
    "node/node.exe",
    "tools/uv.exe",
    "node_modules/next/package.json",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/playwright/cli.js",
    "node_modules/playwright-core/browsers.json",
    "desktop/launcher.cjs",
    "scripts/setup-runtime.mjs",
    "scripts/install-windows-browsers.mjs",
    "scripts/check-browser.mjs",
    "scripts/mini-auto-run.py",
    "scripts/mini-runtime.lock",
    "vendor/mini-swe-agent/pyproject.toml",
  ])
    if (!fs.existsSync(path.join(root, file)))
      throw new Error("Incomplete desktop package: " + file);
  if (
    !fs
      .readdirSync(path.join(root, "src/lib/db/migrations"))
      .some((file) => file.endsWith(".sql"))
  )
    throw new Error("Database migrations are missing.");
  if (!fs.existsSync(path.join(root, ".next/static")))
    throw new Error("Static UI assets are missing.");
  if (!fs.existsSync(path.join(resources, "linux.tar.gz")))
    throw new Error("Linux runtime archive is missing.");
  console.log(
    "Verified packaged runtime, native SQLite, migrations, Agent and browser resources.",
  );
};
