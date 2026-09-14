// Configuration arrives over stdin. Credentials never appear in process arguments.
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on("line", async (line) => {
  if (started) return;
  started = true;
  try {
    const config = JSON.parse(line);
    for (const [key, value] of Object.entries(config.env))
      process.env[key] = String(value);
    process.env.PYTHONUTF8 = "1";
    process.env.PYTHONIOENCODING = "utf-8";
    fs.mkdirSync(process.env.THRUSH_DATA_DIR, { recursive: true });
    if (
      process.platform === "linux" &&
      /VERSION_ID="26.04"/.test(fs.readFileSync("/etc/os-release", "utf8"))
    )
      process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = "ubuntu24.04-x64";
    process.chdir(config.root);
    process.env.PATH =
      path.join(
        config.root,
        "node",
        process.platform === "win32" ? "" : "bin",
      ) +
      path.delimiter +
      (process.env.PATH || "");
    const port = await new Promise((resolve, reject) => {
      const socket = net.createServer();
      socket.on("error", reject);
      socket.listen(0, "127.0.0.1", () => {
        const port = socket.address().port;
        socket.close(() => resolve(port));
      });
    });
    process.env.PORT = String(port);
    process.env.HOSTNAME = "127.0.0.1";
    process.env.NODE_ENV = "production";
    process.stdout.write(JSON.stringify({ type: "port", port }) + "\n");
    require(path.join(config.root, "server.js"));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  if (process.platform === "linux") {
    try {
      process.kill(-process.pid, "SIGTERM");
    } catch {}
  }
  if (process.platform === "win32") {
    require("node:child_process").spawnSync(
      "taskkill.exe",
      ["/pid", String(process.pid), "/t", "/f"],
      { windowsHide: true, stdio: "ignore" },
    );
  }
  process.exit(0);
});
