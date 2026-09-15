<p align="center">
  <img src="https://github.com/user-attachments/assets/bb389b24-24a8-4d2c-a9e2-aec316b43bf5" alt="Thrush logo" width="120" />
</p>

<h1 align="center">Thrush Desktop 2.1.1</h1>

<p align="center">
  <strong>A local desktop workbench for AI coding.</strong><br>
  Work through changes with Assist, or give Auto a task and review the result.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-44-47848F?style=for-the-badge&amp;logo=electron&amp;logoColor=white" alt="Electron 44" />
  <img src="https://img.shields.io/badge/Next.js-15-000000?style=for-the-badge&amp;logo=nextdotjs&amp;logoColor=white" alt="Next.js 15" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&amp;logo=typescript&amp;logoColor=white" alt="TypeScript 5" />
  <img src="https://img.shields.io/badge/SQLite-local_state-003B57?style=for-the-badge&amp;logo=sqlite&amp;logoColor=white" alt="SQLite local state" />
  <img src="https://img.shields.io/badge/mini--swe--agent-bundled-FFB000?style=for-the-badge" alt="Bundled mini-swe-agent" />
</p>

<p align="center">
  <a href="https://github.com/shoyann/thrush-swe-agent/releases/latest">Download for Windows</a> ·
  <a href="docs/desktop.md">Desktop guide</a> ·
  <a href="docs/source-development.md">Run from source</a> ·
  <a href="docs/desktop-validation.md">Validation record</a>
</p>

## Overview

Thrush brings projects, conversations, file review, and coding agents into one desktop app. It has an English interface and runs in either native Windows or Ubuntu through Windows Subsystem for Linux (WSL).

| Mode | How you work | How changes are handled |
| --- | --- | --- |
| **Assist** | Chat with the agent, inspect files, search code, and work through a task step by step. | File edits are prepared as drafts for you to approve before they are applied. |
| **Auto** | Give mini-swe-agent a task, then review its report, diff, logs, and execution history. | Each run uses a separate Git working copy (a worktree). Docker is the default execution environment. |

Projects and conversations are saved locally. Model requests go to your configured provider. Settings lets you choose a provider, store encrypted API keys, prepare Agent and browser dependencies, and switch execution environments.

**Current release: 2.1.1 — Windows 11 x64, internal testing.** The installer is unsigned. Signing, automatic updates, and a macOS desktop release are not included.

## Get started

1. **Install Thrush.** Download `Thrush-2.1.1-windows-x64.exe` from the [2.1.1 release](https://github.com/shoyann/thrush-swe-agent/releases/tag/v2.1.1), run it, and open **Thrush** from your desktop or Start menu. Windows may display an unknown-publisher warning for this unsigned build.
2. **Complete setup.** Choose Windows or a detected Ubuntu WSL environment, configure your model provider and API key, and prepare the dependencies offered by the setup assistant.
3. **Open a project.** Start with **Assist** for an interactive task, or select **Auto** and resolve its readiness checks before starting a run.

The installer includes Electron, Node, and the Windows and Ubuntu service bundles. You do not need a source checkout or a separate Node installation to launch the app.

### What you need

| Component | When it is needed |
| --- | --- |
| Model provider account and API key | For model-backed tasks. DeepSeek, OpenAI, and an Anthropic-compatible gateway are configurable. |
| Git in the selected environment | For project Git operations and Auto worktrees. Auto requires a project with no uncommitted changes. |
| Docker Desktop | For the default Docker Auto environment. Enable Ubuntu under **Settings → Resources → WSL Integration** when using WSL. |
| Ubuntu WSL | Only if you choose WSL execution. Thrush does not install or configure WSL. |
| GitHub CLI (`gh`), signed in | Only when creating a draft pull request on GitHub. |
| Project-specific tools | As required by the project and its execution environment. |

The Anthropic option requires an OpenAI-compatible gateway URL. See the [desktop guide](docs/desktop.md) for environment setup and dependency details.

## Work with Assist or Auto

### Assist

Assist can inspect files, search code, read web pages, run allowlisted commands, and propose edits. Review each file draft and approve or discard it in the UI.

```text
Inspect → Discuss → Draft → Review → Approve or discard
```

File tools restrict paths to the active workspace. Allowlisted commands can still run project code; they are not a hardened sandbox.

### Auto

Auto checks the project's Git state, the Agent runtime, model configuration, and Docker availability for Docker runs. GitHub readiness is checked separately for optional draft pull requests.

For each run, Thrush:

1. Creates a branch and a separate Git worktree for the task.
2. Runs the bundled mini-swe-agent with the selected environment and limits.
3. Collects a report, file changes, diff, logs, and execution history for review.

The run leaves the files in your original project workspace unchanged. You can cancel a running task; Thrush cleans up its owned Docker containers after completion, failure, cancellation, or timeout.

**Publishing is a separate action.** After a successful run, review the report and diff, then choose **Create Draft PR** to open a draft pull request. This requires a GitHub `origin` remote and a signed-in GitHub CLI. Auto does not publish a pull request on its own.

## Local data and environments

Windows and WSL keep separate project histories and databases. Only one environment runs at a time; finish active tasks and dependency preparation before switching.

| Environment | Default data location |
| --- | --- |
| Windows desktop | `%APPDATA%/Thrush/environments/native` |
| WSL desktop | `~/.local/share/thrush/data` |
| Source development | `data/` in the source checkout |

Desktop credentials are encrypted in the app's settings store. History import accepts an old `data` folder into an empty destination; imported Auto runs are available for review only. See [data locations](docs/desktop.md#runtime-profiles-and-data) and [history import](docs/desktop.md#import-history) for details.

## Release validation and limitations

The [2.1.1 validation record](docs/desktop-validation.md) documents live DeepSeek conversations, file tools, edit approvals, Docker Auto repair, cancellation, and timeout cleanup on Windows 11 and WSL Ubuntu 26.04. It also records automated checks, installer checks, and UI review.

Remaining gaps include:

- Clean Ubuntu 22.04 and 24.04 validation; these are the primary WSL targets, while the recorded live tests used 26.04.
- WSL browser support on the tested machine, where Chromium still needs additional system libraries.
- GitHub draft pull request creation from an Auto result, which was not exercised in the recorded live tests.

See the validation record for the complete test scope. Review generated changes before applying or publishing them, and use care with untrusted projects and secrets.

## Development and documentation

The browser workflow remains available for source development. The app uses Electron, Next.js, TypeScript, SQLite, and the bundled mini-swe-agent.

| Guide | Contents |
| --- | --- |
| [Source development](docs/source-development.md) | Browser quickstart, model settings, environment variables, local runtime, and checks |
| [Desktop guide](docs/desktop.md) | Installation, Windows/WSL setup, history import, desktop builds, and packaging |
| [Validation record](docs/desktop-validation.md) | Recorded 2.1.1 results, known gaps, and reproduction commands |
| [Auto technical design](docs/design/auto-mode-technical-design.md) | Original Auto architecture and implementation design |
| [Architecture decisions](docs/adr) | Docker defaults, review before publishing, bundled Agent, and worker design |
