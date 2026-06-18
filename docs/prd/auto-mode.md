# PRD: Thrush Auto Mode

Auto Mode lets users hand a clear coding task to Thrush, have bundled mini-swe-agent attempt the work in an isolated project copy, and receive a plain-language report with reviewable artifacts. It is designed for both non-technical users who need understandable outcomes and technical users who need enough evidence to review the result.

## User Promise

Auto Mode works on a separate copy of the project, does not directly change the main workspace, and does not create a GitHub pull request unless the user explicitly asks it to. It should feel like handing a task to an autonomous assistant, then reviewing what happened before deciding what to do next.

## Modes

**Assist** is for working with the agent step by step. The user can ask questions, explore code, review drafts, and approve writes.

**Auto** is for delegating a clear task. Thrush runs mini-swe-agent, monitors the run, and presents the outcome as an Auto Report plus artifacts.

The internal codename for Assist is Garand, but the user interface must use Assist and Auto.

The project workspace should expose Assist and Auto as top-level tabs. The left sidebar selects projects, while the main workspace switches between the assisted chat experience and the autonomous run experience.

## Target Users

Auto Mode should be understandable to non-technical users and useful to technical reviewers. Non-technical users should understand the result, the reason for failure, and the recommended next action without reading logs. Technical users should be able to inspect the diff, logs, trajectory, changed files, and test output.

## First Version Scope

The first version supports creating an Auto Run for a project, using a recommended execution environment by default, watching run progress, canceling a running task, reading an Auto Report, reviewing the diff, and optionally creating a GitHub Draft PR after review.

Auto Runs use mini-swe-agent's success and failure semantics as the source of truth for whether the autonomous attempt completed. Thrush translates that outcome into product states and a human-readable report.

Thrush should ship with mini-swe-agent bundled under the repository, preferably as a managed Git submodule or vendored dependency. The default Auto experience should not require users to install mini-swe-agent separately.

## Non-Goals

The first version does not directly modify the main workspace, does not automatically create GitHub pull requests, does not default to unrestricted local shell execution, does not run multiple Auto Runs for the same project at the same time, and does not promise that mini-swe-agent will solve every task. It promises a clear autonomous attempt, reviewable artifacts, and an understandable outcome.

## Statuses

Auto Runs use these user-visible states:

- `queued`
- `preparing`
- `running`
- `reporting`
- `completed`
- `failed`
- `canceled`

## Auto Report

Each completed, failed, or canceled Auto Run should produce an Auto Report with these sections:

- Result
- What changed
- Why it changed
- How it was verified
- What needs review
- Risks or unfinished work
- Artifacts

If model-generated reporting fails, Thrush must still generate a fallback report from structured artifacts such as exit status, changed files, diff stat, logs, and trajectory location.

## Artifacts

Auto Runs should keep the original evidence available next to the report:

- Diff
- Diff stat
- Changed files
- Logs
- mini-swe-agent trajectory
- Test output when available
- Draft PR URL when one is created

The report is a summary, not the source of truth. Users must be able to inspect the underlying artifacts.

## Execution Settings

By default, Auto Mode reuses Thrush's existing API and model configuration and selects a recommended execution environment for the project. Users should not need to understand Docker images, mount paths, YAML, or mini-swe-agent configuration to start an Auto Run.

Mini Presets are an advanced feature for custom mini-swe-agent execution settings, such as a different model, cost limit, timeout, Docker image, or advanced mini config override. The primary Auto Run flow should hide Mini Presets behind advanced settings.

The default Auto path must be non-interactive. Users should never see mini-swe-agent's terminal setup wizard or be asked to configure mini separately before the first Auto Run when Thrush already has model configuration.

## Environment Doctor

Before a user starts Auto, Thrush should run an environment readiness check and explain the result in plain language. The check covers Docker, mini-swe-agent, model configuration, Git workspace cleanliness, and GitHub Draft PR readiness.

Hard failures block Start Auto:

- Docker is unavailable when the selected environment is Docker.
- mini-swe-agent cannot be resolved or started.
- The required model API key is missing.
- The project has uncommitted changes.

GitHub readiness is not required to start Auto. If GitHub CLI, authentication, or the origin remote is missing, Thrush should still allow Auto to run but disable Draft PR creation and explain what is missing.

## Safety and Permissions

Auto Runs default to mini-swe-agent's Docker environment. Local execution is an explicit advanced opt-in because it gives the agent unrestricted command access on the host machine.

Before an Auto Run starts, Thrush should explain in plain language that Auto works in an isolated project copy and will not directly change the main workspace.

If the main workspace has uncommitted changes, the first version should block the Auto Run and explain the reason. Thrush should not automatically stash, commit, or discard user work.

## Cancellation

Users can cancel a queued, preparing, or running Auto Run. Canceling should stop the mini-swe-agent process, clean up the active Docker container when possible, and mark the run as `canceled` with a clear report.

## GitHub Draft PR

Creating a GitHub Draft PR is a user-triggered action after the Auto Report and diff are available. Thrush should check GitHub readiness before showing or enabling the action, and failures should explain the concrete reason, such as missing GitHub CLI, missing authentication, missing remote, or push failure.

## Failure Experience

Failures must explain the specific reason and a practical next step. Examples include Docker not running, model configuration missing, dependency installation failure, test failure, timeout, cost limit reached, user cancellation, and GitHub PR creation failure.

Raw stack traces and logs remain available as artifacts, but the primary failure message should be written for a non-technical user.

When the bundled mini-swe-agent dependency install fails, Thrush should distinguish that from the agent failing the coding task. For example, if `uv` times out while downloading Python wheels, the report should say that dependency download timed out, suggest checking network/proxy settings, and invite the user to retry after the cache is warm.

## Windows First

The first implementation targets Windows users first. The product and technical design should handle Windows paths, Docker Desktop mounts, Git worktrees, and Node child process behavior on Windows before expanding the platform matrix.

When Thrush runs from WSL, Docker Desktop must expose Docker to that WSL distro. If Windows Docker is installed but WSL cannot run `docker`, Thrush should tell the user to enable Docker Desktop's WSL integration for Ubuntu.

## Real E2E Acceptance

The first real Docker acceptance run should use the WSL project path, launch Thrush in the in-app browser, create an Auto Run against a real GitHub issue, and verify:

- Auto reaches a final state with a readable report.
- Diff, logs, trajectory, and changed files are visible.
- The main workspace remains unchanged.
- GitHub Draft PR is not created automatically.
- Dependency installation failures, if encountered on first run, are classified with a concrete network/dependency message rather than generic `mini_failed`.
