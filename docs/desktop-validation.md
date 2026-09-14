# Desktop validation record

Date: 2026-09-15 (Asia/Shanghai). Release: 2.1.1. Baseline: GitHub main `daef0a6`. Developed independently on `codex/desktop-app`; existing Assist V2 changes were not included.

## Automated and desktop checks

| Area | Result |
| --- | --- |
| Baseline, import and Auto regressions | 26 tests passed on Windows and Linux |
| Desktop security and loopback transport | 6 tests passed on Windows and Linux |
| ESLint, TypeScript and production builds | Passed |
| Dependency audit | 0 known vulnerabilities at the initial desktop validation |
| Standalone services | Both bundles launch using their bundled Node and native SQLite |
| API authentication | Unauthenticated project, Auto and desktop APIs rejected |
| Assist transport | Real service SSE tested against a local fixture and the live DeepSeek API |
| Draft approval | Approved drafts write the expected file; discarded drafts leave files absent |
| Legacy import | Consistent backup, preserved source, rejected newer schema, invalidated stale actions, history-only Auto Runs |
| Environment switching | Windows → Ubuntu → Windows with separate histories |
| Lifecycle | Active-task environment lock, close-to-tray, background completion, single instance, encrypted keys, crash/restart and history persistence |
| Windows dependencies | Private Python 3.12.13, mini-swe-agent 2.4.1 and Chromium installed; browser launch passed |
| WSL dependencies | Private Python and Agent installed; browser availability is independently reported |
| UI | Setup, welcome, workspace, runtime settings, approval and Diff screenshot review |
| Layout | 800/1024px windows, 100% and 200% DPI, no horizontal overflow |
| Non-ASCII paths | Chinese characters and spaces in data/project paths |
| Installed app | Packaged executable starts without the source working directory; sandboxed UI and settings work |
| Installation | First install, reinstall and upgrade to 2.1.1 tested; the existing encrypted DeepSeek key remains usable |
| Package integrity | Build hook checks Node, Next, SQLite, static files, migrations, Agent and browser entry points |

## Live integration

Live tests use the user's authorized DeepSeek account through the existing encrypted desktop configuration. Keys stay out of source, process arguments and reports. Disposable Git projects contain a deliberately broken addition function and two Python unit tests.

The flow verifies real model replies over SSE, reading a random file marker, drafting an edit, approving it through the UI, and running Auto with Docker `python:3.12-bookworm`. Auto must repair the function, pass its tests, return a report and diff, leave the original workspace unchanged, and remove its container. A second run is canceled after its container starts. An optional 60-second deadline test verifies timeout reporting and cleanup.

Live tests are limited to $0.20 and 12 steps per Auto Run. Normal runs have a 180-second deadline; the deadline verification mode uses 60 seconds. Test reports are written under the ignored `test-results/live` directory.

| Execution environment | Live flow | Auto success run |
| --- | --- | --- |
| native | Conversation, tools, approval, Docker repair, cancellation and deadline cleanup passed | `auto_21d75aeb-2290-4058-8858-6c869e39c096` |
| wsl | Conversation, tools, approval, Docker repair, cancellation and deadline cleanup passed | `auto_992b0895-55e5-43e1-b6f1-9eed06a3376d` |

### Fixes discovered by live testing

- Qualify desktop DeepSeek model names for LiteLLM and pass the configured API base to the Python runner.
- Send DeepSeek's thinking setting at the top level of the JSON request.
- Forward configured Auto limits into WSL explicitly and assert their values in live tests.
- Enforce Auto's deadline in the supervising service and clean up owned containers after success, failure, cancellation and timeout.
- Report model configuration failures accurately even when logs mention Docker.
- Validate Python imports without fetching a remote pricing registry; real runs retain normal cost accounting.
- Avoid stale loopback sockets; retry reset connections once for reads only. Mutating requests and approvals are never automatically replayed.
- Allow enough time for dependency preparation in the live test harness. A deliberately interrupted WSL browser download leaves the prepared Agent available for Auto.

## Remaining environment-dependent checks

- This workstation uses Windows 11 x64 build 26200 and WSL Ubuntu **26.04**. Clean Ubuntu 22.04/24.04 validation remains outstanding; the CI Linux bundle builds on Ubuntu 22.04.
- WSL Chromium needs additional Ubuntu system libraries (the initial launch identified `libnspr4.so`). Browser setup reports the failure and an installation-help link; working Agent/Docker functions remain available.
- GitHub Draft PR creation from an Auto result was not exercised. Local test repositories intentionally have no origin remote.
- A fresh Windows account with a Chinese username, hardware without WSL, and deliberately broken WSL localhost forwarding were unavailable. Chinese paths were tested, which does not substitute for a different Windows account.
- The installer is unsigned and intended for internal testing. Signing, automatic updates and macOS are outside this release.

## Reproduce

See [desktop.md](desktop.md) for build commands. Additional checks:

```text
npm run test:lifecycle
node scripts/test-dpi.mjs
npm run test:installed -- "C:\Users\you\AppData\Local\Programs\Thrush\Thrush.exe"
npm run test:live -- native
npm run test:live -- wsl
```

On Windows, set `THRUSH_LIVE_TIMEOUT_CHECK=1` before the live command to include the deadline test. Live tests require an already configured DeepSeek key and Docker. They spend API credits and are not run automatically by CI.

## Release artifact

`Thrush-2.1.1-windows-x64.exe` — 401,422,630 bytes.

SHA-256: `68964fa5eb45bd19f61b20c23ffd4947c9b253165a2411368e9d9e57a1a3dd97`.
