---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: run_terminal_command, ask_user_question, spawn_subagent, search_replace
---

Invoke the `codex:codex-rescue` subagent via `spawn_subagent` (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call a skill named `codex:codex-rescue` or re-enter this command. Run inline so the subagent tool stays in scope.
The final user-visible response must be Codex's output verbatim.

Raw user request (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- Forward the raw user request above to `codex:codex-rescue` only through the structured `spawn_subagent` prompt field. Do not put it in `run_terminal_command` or any other shell command.
- The subagent must use the args-file channel for its final `task` invocation. If its complete final task argument string is empty or whitespace-only, it skips `args-path` and `search_replace`, then invokes `task` without `--args-file`.
- Otherwise, immediately before invoking `task`, the subagent must:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path task` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the complete final task argument string. This creates the file without passing the argument text through a shell.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --args-file "<trusted path from step 1>"`.
- The subagent must request a fresh path for every invocation and never reuse a consumed path.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the failure. Never fall back to putting request text in a shell command.

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background (`background: true`).
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Grok. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this host session by running:

```bash
node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `ask_user_question` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should invoke `task` exactly once through the safe argument transport above and return that command's stdout as-is.
- Return the Codex companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Accepted effort names are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; actual availability depends on the selected model.
- Leave the model unset unless the user explicitly asks for one. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
