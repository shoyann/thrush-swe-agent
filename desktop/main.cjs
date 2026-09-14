const {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  Tray,
  Menu,
  Notification,
  nativeImage,
  session,
} = require("electron");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const {
  trustedUrl,
  externalUrl,
  redact,
  credentials,
  validateSettings,
} = require("./security.cjs");
const exec = promisify(execFile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "thrush",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
app.setName("Thrush");
if (!app.isPackaged && process.env.THRUSH_TEST_PROFILE)
  app.setPath("userData", process.env.THRUSH_TEST_PROFILE);
let win,
  tray,
  child,
  endpoint,
  auth,
  stopping = false,
  quitting = false,
  switching = false;
let status = {
  phase: "starting",
  message: "Starting your workspace…",
  active: 0,
};
let settings = {
  environment: "native",
  distribution: "",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseURL: "",
  configured: false,
};
let encryptedKeys = {};
let distributions = [];
let previousActive = 0;
let lastSetup = false;
const resources = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.join(app.getAppPath(), "desktop-resources");
const profilePath = () => path.join(app.getPath("userData"), "desktop.json");
const logPath = () => path.join(app.getPath("userData"), "logs", "desktop.log");
function apiKey() {
  const stored = encryptedKeys[settings.provider];
  return stored ? safeStorage.decryptString(Buffer.from(stored, "base64")) : "";
}
function log(text) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  if (fs.existsSync(logPath()) && fs.statSync(logPath()).size > 2 * 1024 * 1024)
    fs.renameSync(logPath(), logPath() + ".previous");
  let key = "";
  try {
    key = apiKey();
  } catch {}
  fs.appendFileSync(
    logPath(),
    new Date().toISOString() + " " + redact(text, [key, auth?.token]) + "\n",
  );
}
function state() {
  return {
    ...status,
    settings: {
      ...settings,
      hasKey: Boolean(encryptedKeys[settings.provider]),
    },
    distributions,
    version: app.getVersion(),
  };
}
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send("desktop:state", state());
}
function save() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const dest = profilePath();
  fs.writeFileSync(
    dest + ".tmp",
    JSON.stringify({ settings, encryptedKeys, bounds: win?.getNormalBounds() }),
  );
  fs.renameSync(dest + ".tmp", dest);
}
async function wsl(args, options = {}) {
  return exec("wsl.exe", args, {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}
async function detectDistributions() {
  if (process.platform !== "win32") return [];
  try {
    const result = await wsl(["--list", "--quiet"], { encoding: "buffer" });
    const names = result.stdout
      .toString("utf16le")
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((n) => n.trim())
      .filter(Boolean);
    const valid = [];
    for (const name of names) {
      try {
        const { stdout } = await wsl([
          "-d",
          name,
          "--exec",
          "cat",
          "/etc/os-release",
        ]);
        if (
          /^ID=ubuntu$/m.test(stdout) &&
          /VERSION_ID="(22.04|24.04|26.04)"/.test(stdout)
        )
          valid.push(name);
      } catch {}
    }
    return valid;
  } catch {
    return [];
  }
}
function modelEnv() {
  const provider = settings.provider.toUpperCase();
  return {
    MODEL_PROVIDER: settings.provider,
    [provider + "_MODEL"]: settings.model,
    [provider + "_API_KEY"]: apiKey(),
    ...(settings.baseURL ? { [provider + "_BASE_URL"]: settings.baseURL } : {}),
  };
}
async function serviceRequest(route, options = {}) {
  if (!endpoint) throw new Error("The local service is not running.");
  return fetch(endpoint + route, {
    ...options,
    headers: { ...options.headers, authorization: "Bearer " + auth.token },
    signal: options.signal || AbortSignal.timeout(15000),
  });
}
async function activityCount() {
  if (!endpoint) return 0;
  const response = await serviceRequest("/api/desktop");
  if (!response.ok) throw new Error("Unable to check active tasks.");
  const payload = await response.json();
  if (payload.instance !== auth.instance)
    throw new Error("Local service identity mismatch.");
  lastSetup = Boolean(payload.setup?.running);
  return payload.active + (lastSetup ? 1 : 0);
}
async function launch() {
  status = {
    phase: "starting",
    message: "Starting your workspace…",
    active: 0,
  };
  broadcast();
  stopping = false;
  endpoint = null;
  auth = credentials();
  let root, data, command, args;
  if (settings.environment === "wsl") {
    if (!distributions.includes(settings.distribution))
      throw new Error(
        "The selected Ubuntu distribution is unavailable. Select Windows or install Ubuntu in WSL.",
      );
    const distro = settings.distribution;
    const home = (
      await wsl(["-d", distro, "--exec", "printenv", "HOME"])
    ).stdout.trim();
    if (!home.startsWith("/"))
      throw new Error("Cannot resolve the WSL user home.");
    root = home + "/.local/share/thrush/app/" + app.getVersion();
    data =
      home +
      "/.local/share/thrush/" +
      (!app.isPackaged && process.env.THRUSH_TEST_PROFILE
        ? "test-" + path.basename(process.env.THRUSH_TEST_PROFILE)
        : "data");
    const archive = path.join(resources(), "linux.tar.gz");
    if (!fs.existsSync(archive))
      throw new Error("The Linux runtime bundle is missing. Reinstall Thrush.");
    const linuxArchive = (
      await wsl(["-d", distro, "--exec", "wslpath", "-a", archive])
    ).stdout.trim();
    await wsl(["-d", distro, "--exec", "mkdir", "-p", root, data]);
    const marker = await wsl([
      "-d",
      distro,
      "--exec",
      "test",
      "-f",
      root + "/.installed",
    ]).then(
      () => true,
      () => false,
    );
    if (!marker || !app.isPackaged) {
      status.message = "Preparing the Ubuntu application runtime…";
      broadcast();
      await wsl(
        ["-d", distro, "--exec", "tar", "-xzf", linuxArchive, "-C", root],
        { timeout: 180000 },
      );
      await wsl(["-d", distro, "--exec", "touch", root + "/.installed"]);
    }
    command = "wsl.exe";
    args = [
      "-d",
      distro,
      "--exec",
      "setsid",
      "--wait",
      root + "/node/bin/node",
      root + "/desktop/launcher.cjs",
    ];
  } else {
    root = path.join(
      resources(),
      process.platform === "win32" ? "windows" : "linux",
    );
    data = path.join(app.getPath("userData"), "environments", "native");
    command = path.join(
      root,
      "node",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
    args = [path.join(root, "desktop", "launcher.cjs")];
    if (!fs.existsSync(command))
      throw new Error(
        "The application runtime is missing. Build or reinstall the desktop package.",
      );
  }
  const sep =
    settings.environment === "wsl" || process.platform !== "win32"
      ? "/"
      : path.sep;
  const env = {
    ...modelEnv(),
    THRUSH_DESKTOP: "1",
    THRUSH_RESOURCE_DIR: root,
    THRUSH_DATA_DIR: data,
    THRUSH_RUNTIME_DIR: data + sep + "runtime",
    THRUSH_LOG_DIR: data + sep + "logs",
    THRUSH_INSTANCE_ID: auth.instance,
    AGENT_API_SECRET: auth.token,
    PLAYWRIGHT_BROWSERS_PATH: data + sep + "browsers",
    MSWEA_GLOBAL_CONFIG_DIR: data + sep + "mini-config",
  };
  const ownChild = (child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform !== "win32" ? { detached: true } : {}),
  }));
  let localPort;
  const lines = readline.createInterface({ input: ownChild.stdout });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "port") {
        localPort = event.port;
        return;
      }
    } catch {}
    log(line);
  });
  ownChild.stderr.on("data", (buffer) => log(buffer.toString("utf8")));
  ownChild.on("error", (error) => {
    if (child === ownChild) {
      status = { phase: "error", message: error.message, active: 0 };
      broadcast();
    }
  });
  ownChild.on("exit", (code) => {
    if (child !== ownChild || stopping) return;
    endpoint = null;
    status = {
      phase: "error",
      message:
        "The local service stopped. Restart to recover your history. Running tasks will not be replayed. (exit " +
        code +
        ")",
      active: 0,
    };
    broadcast();
    log(status.message);
  });
  ownChild.stdin.on("error", (error) => log(error.message));
  ownChild.stdin.write(JSON.stringify({ root, env }) + "\n");
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && ownChild.exitCode === null) {
    if (localPort) {
      endpoint = "http://127.0.0.1:" + localPort;
      try {
        await activityCount();
        status = { phase: "ready", message: "", active: 0 };
        broadcast();
        return;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await stop();
  throw new Error(
    settings.environment === "wsl"
      ? "Ubuntu started but its local service could not be reached. Check WSL localhost forwarding, then retry."
      : "The local service did not become ready. Open diagnostic logs and retry.",
  );
}
async function stop() {
  stopping = true;
  if (endpoint)
    await serviceRequest("/api/desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "shutdown" }),
      signal: AbortSignal.timeout(15000),
    }).catch((error) => log(error.message));
  const owned = child;
  child = null;
  endpoint = null;
  if (owned?.pid) {
    if (settings.environment === "wsl") {
      // Parent stdin closes the service; the Linux launcher also owns its subprocess tree.
      owned.stdin.end();
    } else if (process.platform === "win32") {
      await exec("taskkill.exe", ["/pid", String(owned.pid), "/t", "/f"], {
        windowsHide: true,
      }).catch(() => {});
    } else {
      try {
        process.kill(-owned.pid, "SIGTERM");
      } catch {}
    }
  }
  status.active = 0;
}
async function restart() {
  if (switching) throw new Error("The environment is already changing.");
  if (endpoint && (await activityCount()))
    throw new Error("Wait for active tasks and dependency setup to finish.");
  switching = true;
  try {
    await stop();
    await launch();
    await win.loadURL("thrush://app/");
  } finally {
    switching = false;
  }
}
function bootstrapHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px system-ui;background:#fafaf8;color:#202421;margin:0;display:grid;place-items:center;height:100vh}.box{max-width:500px;padding:40px}h1{font-size:32px}p{line-height:1.7;color:#637066}button{padding:12px 18px;border:1px solid #d8ddd8;border-radius:8px;background:white;margin:8px 8px 0 0;cursor:pointer}</style></head><body><div class="box"><p>THRUSH / DESKTOP</p><h1>Your next idea starts here.</h1><p id="message">Starting your workspace…</p><button id="retry">Retry</button><button id="native">Use Windows</button><button id="logs">Open logs</button></div><script>const api=window.thrushDesktop;function paint(s){document.getElementById('message').textContent=s.message||'Opening workspace…'}api.getState().then(paint);api.onState(paint);document.getElementById('retry').onclick=()=>api.restart().catch(e=>paint({message:e.message}));document.getElementById('logs').onclick=()=>api.openLogs();document.getElementById('native').onclick=async()=>{const s=await api.getState();await api.configure({...s.settings,environment:'native',distribution:''}).catch(e=>paint({message:e.message}))};</script></body></html>`;
}
function checkSender(event) {
  if (
    !win ||
    event.sender !== win.webContents ||
    !trustedUrl(event.senderFrame?.url || "") ||
    event.senderFrame !== win.webContents.mainFrame
  )
    throw new Error("Untrusted desktop request.");
}
async function requestQuit() {
  if (quitting) return;
  let active = status.active;
  try {
    active = await activityCount();
  } catch {}
  if (active) {
    const answer = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Keep working", "Stop tasks and quit"],
      defaultId: 0,
      cancelId: 0,
      message: "Thrush is still working.",
      detail:
        "Quitting stops active tasks and dependency setup. You can close the window to keep working in the background.",
    });
    if (answer.response !== 1) return;
  }
  quitting = true;
  save();
  await stop();
  app.quit();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      let bounds;
      try {
        const saved = JSON.parse(fs.readFileSync(profilePath(), "utf8"));
        settings = { ...settings, ...saved.settings };
        encryptedKeys = saved.encryptedKeys || {};
        bounds = saved.bounds;
      } catch {}
      distributions = await detectDistributions();
      const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, "icon.png")
        : path.join(app.getAppPath(), "public/icon.png");
      win = new BrowserWindow({
        width: Math.max(900, Math.min(bounds?.width || 1440, 2200)),
        height: Math.max(600, Math.min(bounds?.height || 940, 1500)),
        minWidth: 760,
        minHeight: 560,
        title: "Thrush",
        backgroundColor: "#fafaf8",
        icon: iconPath,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (externalUrl(url)) void shell.openExternal(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (!trustedUrl(url)) {
          event.preventDefault();
          if (externalUrl(url)) void shell.openExternal(url);
        }
      });
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      protocol.handle("thrush", async (request) => {
        if (!trustedUrl(request.url))
          return new Response("Forbidden", { status: 403 });
        const url = new URL(request.url);
        if (url.pathname === "/__desktop")
          return new Response(bootstrapHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        if (!endpoint)
          return new Response(bootstrapHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        try {
          const headers = new Headers(request.headers);
          headers.set("authorization", "Bearer " + auth.token);
          headers.delete("host");
          headers.delete("connection");
          const response = await fetch(endpoint + url.pathname + url.search, {
            method: request.method,
            headers,
            body: ["GET", "HEAD"].includes(request.method)
              ? undefined
              : await request.arrayBuffer(),
            redirect: "manual",
            signal: request.signal,
          });
          const resultHeaders = new Headers(response.headers);
          resultHeaders.delete("content-encoding");
          resultHeaders.delete("content-length");
          resultHeaders.set(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
          );
          return new Response(response.body, {
            status: response.status,
            headers: resultHeaders,
          });
        } catch (error) {
          return Response.json(
            { error: "Local service unavailable: " + error.message },
            { status: 503 },
          );
        }
      });
      ipcMain.handle("desktop:state", (event) => {
        checkSender(event);
        return state();
      });
      ipcMain.handle("desktop:directory", async (event) => {
        checkSender(event);
        const result = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      ipcMain.handle("desktop:logs", async (event) => {
        checkSender(event);
        fs.mkdirSync(path.dirname(logPath()), { recursive: true });
        return shell.openPath(path.dirname(logPath()));
      });
      ipcMain.handle("desktop:restart", async (event) => {
        checkSender(event);
        await restart();
        return state();
      });
      ipcMain.handle("desktop:configure", async (event, value) => {
        checkSender(event);
        if (switching)
          throw new Error("An environment change is already in progress.");
        if (endpoint && (await activityCount()))
          throw new Error("Finish the active task before changing settings.");
        distributions = await detectDistributions();
        const next = validateSettings(value, distributions);
        const previous = settings;
        switching = true;
        try {
          await stop();
          if (value.apiKey?.trim()) {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("Windows credential encryption is unavailable.");
            encryptedKeys[next.provider] = safeStorage
              .encryptString(value.apiKey.trim())
              .toString("base64");
          }
          settings = next;
          save();
          await launch();
          await win.loadURL("thrush://app/");
          return state();
        } catch (error) {
          status = { phase: "error", active: 0, message: error.message };
          broadcast();
          if (!endpoint) await win.loadURL("thrush://app/__desktop");
          throw error;
        } finally {
          switching = false;
          void previous;
        }
      });
      tray = new Tray(
        nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }),
      );
      tray.setToolTip("Thrush");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: "Open Thrush",
            click: () => {
              win.show();
              win.focus();
            },
          },
          { type: "separator" },
          { label: "Quit", click: () => void requestQuit() },
        ]),
      );
      tray.on("double-click", () => win.show());
      win.on("close", (event) => {
        if (quitting) return;
        event.preventDefault();
        void activityCount()
          .catch(() => status.active)
          .then((active) => {
            if (active) {
              save();
              win.hide();
            } else void requestQuit();
          });
      });
      app.on("before-quit", (event) => {
        if (!quitting) {
          event.preventDefault();
          void requestQuit();
        }
      });
      await win.loadURL("thrush://app/__desktop");
      try {
        await launch();
        await win.loadURL("thrush://app/");
      } catch (error) {
        status = { phase: "error", message: error.message, active: 0 };
        log(error.message);
        broadcast();
      }
      setInterval(async () => {
        if (!endpoint || switching || stopping) return;
        try {
          const active = await activityCount();
          if (
            previousActive > 0 &&
            active === 0 &&
            !win.isFocused() &&
            Notification.isSupported()
          )
            new Notification({
              title: "Thrush",
              body: "Your task has finished. Open Thrush to review the result.",
              icon: iconPath,
            }).show();
          previousActive = active;
          status.active = active;
          broadcast();
        } catch (error) {
          log(error.message);
        }
      }, 2500).unref();
    })
    .catch((error) => {
      dialog.showErrorBox("Thrush could not start", error.message);
      app.exit(1);
    });
}
