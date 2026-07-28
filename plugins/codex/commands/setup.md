---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: run_terminal_command, ask_user_question, search_replace
---

Raw slash-command arguments (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- If the raw arguments above are empty or whitespace-only, skip `args-path` and `search_replace`, then run:

```bash
node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json
```

- Otherwise:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path setup` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the exact raw slash-command argument text above.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json --args-file "<trusted path from step 1>"`.
- Request a fresh path for every invocation. Never reuse a path from an earlier invocation because the file is consumed and deleted.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the error. Never fall back to placing the raw arguments in a shell command.

If the result says Codex is unavailable and npm is available:
- Use `ask_user_question` exactly once to ask whether Grok should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun `setup` using the safe argument transport above. This is a new invocation, so request a new path and write a new args file when the raw arguments are non-empty.

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `codex login` (or `!codex login` in shells that support bang-exec).
