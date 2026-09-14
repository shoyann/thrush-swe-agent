# Thrush Desktop for Windows

Thrush Desktop 2.1 is a Windows x64 internal-test application. It packages Electron, a production Next.js service, Node 22.22.3, and separate native and Ubuntu service resources. No source checkout or system Node installation is required to launch it.

## Install and start

Run the NSIS installer, then open **Thrush** from the Start menu or desktop shortcut. The first-run assistant lets you choose Windows or a detected Ubuntu WSL distribution, configure a model endpoint and key, prepare Agent/browser dependencies, and optionally import history.

The internal-test installer is unsigned. Windows may show a publisher warning. Public release signing and automatic updates are not included.

Git must be installed in the selected environment. Docker Desktop and its WSL integration are required for Docker Auto Runs. GitHub CLI authentication is only needed to create a Draft PR. Thrush does not install or reconfigure Docker or WSL. Project-specific tools remain the user's responsibility.

The current Anthropic option uses the existing OpenAI-compatible gateway protocol; it requires a compatible base URL.

## Runtime profiles and data

Windows data lives under Electron's userData directory, normally `%APPDATA%/Thrush/environments/native`. Encrypted model keys, window preferences, and desktop diagnostics live in the parent userData directory.

WSL application resources live under `~/.local/share/thrush/app/<version>`, and its data lives under `~/.local/share/thrush/data`. Windows and WSL databases are intentionally separate. Finish active tasks and dependency preparation before switching environments.

Ubuntu 22.04 and 24.04 are the primary supported WSL targets. Ubuntu 26.04 is detected as well and uses the Ubuntu 24.04 Chromium compatibility build. Browser system libraries must be present; runtime preparation reports installation errors without elevating privileges.

Only one runtime runs at a time. Close the window during a task to keep it running in the tray. Closing an idle window exits. Explicit Quit offers to stop active work. Interrupted runs are never automatically replayed.

## Import history

Choose the old **data folder**, containing `thrush.db`, in the matching execution environment. Import is allowed only into an empty target.

Import validates migration versions and makes a consistent SQLite backup before copying project, session, and artifact data. The original database and Git worktrees are unchanged. Imported Auto Runs are review-only history; pending approvals are cleared. Missing project paths and artifacts are reported.

Databases from newer unreleased Assist V2 branches are rejected rather than downgraded. Import is not a cross-operating-system path migration or an automatic merge of existing databases.

## Development and packaging

Use a separate checkout/worktree with recursive submodules.

```text
npm ci
npm test
npm run test:desktop
npm run lint
npx tsc --noEmit
npm run build
npm run desktop:stage
```

Run the build and staging on Linux to produce `desktop-resources/linux.tar.gz`. Build and stage on Windows to produce `desktop-resources/windows`, then copy the Linux archive into Windows's `desktop-resources`.

```text
npm run desktop:dev
npm run test:service
npm run test:ui
node scripts/test-review.mjs
node scripts/test-wsl.mjs
npm run test:lifecycle
npm run desktop:package
npm run test:installed -- "C:\Users\you\AppData\Local\Programs\Thrush\Thrush.exe"
```

The Windows installer appears in `release/`. The workflow `.github/workflows/desktop.yml` builds the Linux archive on Ubuntu 22.04 and the installer on Windows.

The packager verifies that the installed runtime contains Next.js, native SQLite, SQL migrations, Agent sources and browser entry points before producing an installer. Windows browser preparation uses the Windows network stack for downloads and verifies Chromium by actually launching it.

Node and uv versions and SHA-256 values are pinned in `scripts/runtime-downloads.json`. Agent dependencies are pinned in `scripts/mini-runtime.lock`. Staging excludes environment files and user data. Electron's main process has no SQLite dependency: the standalone service uses platform-specific native modules with the bundled Node ABI.

## Interfaces

- `THRUSH_RESOURCE_DIR`: immutable bundled service resources.
- `THRUSH_DATA_DIR`: SQLite, workspaces, artifacts and backups.
- `THRUSH_RUNTIME_DIR`: private Python, Agent build sources and caches.
- `THRUSH_LOG_DIR`: service diagnostics.
- `THRUSH_DESKTOP=1`: desktop API authentication and startup recovery.

Without desktop variables, source development keeps its original data location. Browser UI requests are accepted without embedding credentials only in development mode from an exact loopback same origin. Direct API clients still use the existing Bearer protocol.

The custom `thrush://app` handler forwards API/SSE requests through the main process, injecting a per-launch random token. All desktop business API routes require that token. The renderer has no Node integration; the preload bridge permits settings, environment lifecycle, directory selection and diagnostic-log opening only.

## Verification

Automated coverage includes baseline unit tests, source-preserving import, API authentication, standalone startup, local-fixture model SSE, real draft approval/cancel, artifact rendering, Windows/WSL profile switching, and desktop layout screenshots.

Tests use temporary profiles and projects. Real provider spending, GitHub publishing, and Docker execution require configured external services and are not simulated as successful live integrations.

See [the validation record](desktop-validation.md) for actual results and remaining environment-dependent checks.
