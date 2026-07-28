---
user-invocable: true
name: cancel
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: run_terminal_command, search_replace
---

Raw slash-command arguments (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- If the raw arguments above are empty or whitespace-only, skip `args-path` and `search_replace`, then run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel`.
- Otherwise:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path cancel` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the exact raw slash-command argument text above.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel --args-file "<trusted path from step 1>"`.
- Request a fresh path for every invocation. Never reuse a path from an earlier invocation because the file is consumed and deleted.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the error. Never fall back to placing the raw arguments in a shell command.

Present the command output to the user exactly as returned.
