# Desktop validation record

Date: 2026-09-14. Baseline: GitHub main `daef0a6`. Development branch: `codex/desktop-app`.

## Verified

| Area | Result |
| --- | --- |
| Baseline and import tests | 23 passed on Windows and Linux |
| Desktop origin, credentials and settings tests | 4 passed |
| ESLint, TypeScript and production builds | Passed on Windows and Linux |
| Dependency audit | 0 known vulnerabilities at validation time |
| Standalone services | Both platform bundles launch with their own Node and SQLite |
| API authentication | Unauthenticated project, Auto and desktop APIs reject requests |
| Assist transport | Real service SSE completes against a local model fixture |
| Draft approval | Approving writes the intended file; discarding leaves it absent |
| Legacy import | Consistent backup, original data preserved, newer schema rejected, stale actions cleared, history-only Auto Runs |
| Environment switching | Windows → Ubuntu → Windows, separate project histories |
| Lifecycle | Active-task environment lock, close-to-tray, background completion, single instance, encrypted key storage, service crash/restart and history persistence |
| Managed Windows dependencies | Python 3.12.13, mini-swe-agent 2.4.1 and Chromium installed; actual browser launch passed |
| Managed WSL dependencies | Python/Agent installed; Chromium downloaded, missing OS libraries correctly reported |
| UI review | Setup, welcome, workspace, runtime settings, approval and Diff screenshots |
| Layout | 800/1024px windows, native display scale, forced 100% and 200% DPI; no horizontal overflow |
| Non-ASCII paths | Chinese characters and spaces in data and project directories |
| Installed Windows application | Passed: packaged executable launches from a temporary working directory; sandboxed UI and settings are usable |
| NSIS installation | First install and same-version reinstall completed; user-data sentinel survived; Start menu and desktop shortcuts exist |
| Package resources | Build hook verifies Node, Next.js, native SQLite, static assets, SQL migrations, Agent sources and browser setup entry points |

The Windows browser installer uses the Windows network stack. Downloads that fail or stall return a retryable setup error. Browser readiness requires successfully launching Chromium, rather than checking for a downloaded folder.

## Environment-dependent limits

- This workstation runs Windows 11 x64 (build 26200) and Ubuntu **26.04** in WSL. Ubuntu 22.04/24.04 are the intended primary WSL targets; clean-machine validation on those versions remains outstanding. The CI Linux bundle builds on Ubuntu 22.04.
- Docker's Windows daemon was unavailable and Ubuntu's Docker Desktop integration was unavailable. Live Auto container execution/cancellation and cleanup of a running container remain unverified here. Readiness blocking and application-owned process lifecycle are covered.
- WSL Chromium cannot launch until Ubuntu browser system libraries are installed; the current missing library is `libnspr4.so`. The UI reports this and links to Playwright's system dependency instructions.
- Live paid model endpoints and GitHub Draft PR publishing were not exercised. SSE used a local protocol fixture; Diff/report screenshots include explicit history fixtures.
- A fresh Windows account with a Chinese username, WSL-not-installed hardware, and deliberately broken WSL localhost forwarding were not available. Chinese paths were tested, but that is not equivalent to testing a different Windows account.
- The installer is an unsigned internal-test build. Public signing, automatic updates and macOS are outside this release.

## Reproduce

Use the commands in [desktop.md](desktop.md). Additional checks:

```text
npm run test:lifecycle
node scripts/test-dpi.mjs
npm run test:installed -- "C:\Users\you\AppData\Local\Programs\Thrush\Thrush.exe"
```

UI test profiles and fixture workspaces are isolated. No live API keys, source databases or existing Assist V2 changes were imported into the delivered app.
