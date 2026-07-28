---
user-invocable: true
name: transfer
description: Transfer the current Grok session into a resumable Codex thread
argument-hint: "[--source <session-jsonl>]"
disable-model-invocation: true
allowed-tools: run_terminal_command, search_replace
---

Raw slash-command arguments (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- If the raw arguments above are empty or whitespace-only, skip `args-path` and `search_replace`, then run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer`.
- Otherwise:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path transfer` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the exact raw slash-command argument text above.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer --args-file "<trusted path from step 1>"`.
- Request a fresh path for every invocation. Never reuse a path from an earlier invocation because the file is consumed and deleted.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the error. Never fall back to placing the raw arguments in a shell command.

Present the command output to the user exactly as returned. Preserve the Codex session ID and the `codex resume <session-id>` command.

Notes:
- Grok sessions under `~/.grok/sessions/**/chat_history.jsonl` are converted to Codex-importable turns automatically.
- Staging for Codex import is written under `~/.claude/projects/-grok-codex-transfer/` (auto-created). That path is a Codex CLI convention, not a Claude Code requirement — pure Grok machines work without installing Claude.
- Prefer the SessionStart hook's auto-detected transcript; use `--source` only as a manual override.
