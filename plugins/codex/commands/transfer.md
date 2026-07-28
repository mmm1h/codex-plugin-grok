---
description: Transfer the current Grok session into a resumable Codex thread
argument-hint: "[--source <session-jsonl>]"
disable-model-invocation: true
allowed-tools: run_terminal_command
---

!`node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.

Notes:
- Grok sessions under `~/.grok/sessions/**/chat_history.jsonl` are converted to Codex-importable turns automatically.
- Staging for Codex import is written under `~/.claude/projects/-grok-codex-transfer/` (auto-created). That path is a Codex CLI convention, not a Claude Code requirement — pure Grok machines work without installing Claude.
- Prefer the SessionStart hook's auto-detected transcript; use `--source` only as a manual override.
