# Thrush

Thrush is a local dual-mode software engineering agent workbench with separate collaboration paths for assisted edits and autonomous task runs.

## Language

**Assist Mode**:
A session-scoped, semi-automatic collaboration path where the agent proposes and stages changes for user approval.
_Avoid_: semi-auto mode, original mode, chat mode

**Garand**:
The internal codename for Assist Mode. It must not be used as the user-visible product name.
_Avoid_: M1 Garand in UI copy, Garand Mode

**Auto Run**:
A project-scoped autonomous task run that attempts to solve a user request independently and returns reviewable artifacts.
_Avoid_: auto session, auto chat, full-auto reply

**Auto Mode**:
The UI path that creates and monitors Auto Runs.
_Avoid_: autonomous Assist Mode, agent mode flag

**Auto Report**:
A human-readable summary of an Auto Run that explains what changed, how it was verified, and what still needs review.
_Avoid_: raw trajectory, command log, mini-swe-agent dump

**Mini Preset**:
A saved Auto Run execution configuration that tells Thrush how to run mini-swe-agent for a task.
_Avoid_: raw mini config, YAML profile
