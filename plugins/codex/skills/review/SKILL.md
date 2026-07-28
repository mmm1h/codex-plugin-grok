---
user-invocable: true
name: review
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: read_file, list_dir, grep, run_terminal_command, ask_user_question, search_replace
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- If the raw arguments above are empty or whitespace-only, skip `args-path` and `search_replace`, then invoke `review` without `--args-file`.
- Otherwise, immediately before invoking `review`:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path review` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the exact raw slash-command argument text above. This creates the file without passing the argument text through a shell.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --args-file "<trusted path from step 1>"`.
- Request a fresh path for every invocation. Never reuse a path from an earlier invocation because the file is consumed and deleted.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the error. Never fall back to placing the raw arguments in a shell command.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review as a Grok background shell task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `ask_user_question` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Grok's `run_terminal_command(..., background: true)` is what actually detaches the run with completion callbacks.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run the `review` command selected by the safe argument transport above in the foreground.
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `run_terminal_command` in the background:
```
run_terminal_command({
  command: `the review command selected by the safe argument transport above`,
  description: "Codex review",
  background: true
})
```
- Do not poll or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress."
