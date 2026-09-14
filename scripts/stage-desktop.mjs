import {
  cpSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = process.cwd();
const platform = process.platform === "win32" ? "windows" : "linux";
const manifest = JSON.parse(
  readFileSync(path.join(root, "scripts/runtime-downloads.json"), "utf8"),
);
const destination = path.join(root, "desktop-resources", platform);
const cache = path.join(root, ".desktop-cache");
mkdirSync(cache, { recursive: true });
if (
  !path.resolve(destination).startsWith(path.resolve(root) + path.sep) ||
  (existsSync(destination) &&
    realpathSync(destination) !== path.resolve(destination))
)
  throw new Error("Unsafe staging destination.");
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(command + " failed: " + result.status);
}
async function archive(asset) {
  const filename = path.basename(new URL(asset.url).pathname);
  const target = path.join(cache, filename);
  if (!existsSync(target)) {
    console.log("Downloading " + filename);
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error("Download failed: " + response.status);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  if (digest !== asset.sha256)
    throw new Error("Checksum mismatch: " + filename);
  const unpack = path.join(cache, filename + ".unpacked");
  mkdirSync(unpack, { recursive: true });
  if (filename.endsWith(".zip"))
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath '" +
        target.replaceAll("'", "''") +
        "' -DestinationPath '" +
        unpack.replaceAll("'", "''") +
        "' -Force",
    ]);
  else run("tar", ["-xf", target, "-C", unpack]);
  return unpack;
}
if (!existsSync(path.join(root, ".next/standalone/server.js")))
  throw new Error("Run npm run build first.");
// Copy traced production files; never copy application data or development secrets.
cpSync(path.join(root, ".next/standalone"), destination, {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(path.join(root, ".next/standalone"), source);
    const first = relative.split(path.sep)[0];
    return (
      (!relative ||
        [".next", "node_modules", "server.js", "package.json"].includes(
          first,
        )) &&
      !/^\.env(?:\.|$)/.test(path.basename(source))
    );
  },
});
for (const entry of [
  ".next/static",
  "public",
  "src/lib/db/migrations",
  "scripts",
  "desktop/launcher.cjs",
  "vendor/mini-swe-agent",
]) {
  const target = path.join(destination, entry);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(path.join(root, entry), target, {
    recursive: true,
    filter: (source) =>
      ![".git", "__pycache__"].includes(path.basename(source)),
  });
}
for (const name of ["playwright", "playwright-core"]) {
  cpSync(
    realpathSync(path.join(root, "node_modules", name)),
    path.join(destination, "node_modules", name),
    { recursive: true },
  );
}
const nodeArchive = await archive(manifest[platform].node);
const nodeDir = readdirSync(nodeArchive).find((n) => n.startsWith("node-v"));
cpSync(path.join(nodeArchive, nodeDir), path.join(destination, "node"), {
  recursive: true,
});
const uvArchive = await archive(manifest[platform].uv);
const uvName = platform === "windows" ? "uv.exe" : "uv";
const uvPath = existsSync(path.join(uvArchive, uvName))
  ? path.join(uvArchive, uvName)
  : path.join(uvArchive, readdirSync(uvArchive)[0], uvName);
mkdirSync(path.join(destination, "tools"), { recursive: true });
cpSync(uvPath, path.join(destination, "tools", uvName));
if (platform === "linux") {
  chmodSync(path.join(destination, "tools/uv"), 0o755);
  chmodSync(path.join(destination, "node/bin/node"), 0o755);
  run("tar", [
    "-czf",
    path.join(root, "desktop-resources/linux.tar.gz"),
    "-C",
    destination,
    ".",
  ]);
}
console.log("Staged " + platform + " desktop runtime at " + destination);
