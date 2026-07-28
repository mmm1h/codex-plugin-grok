---
user-invocable: true
name: adversarial-review
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: read_file, list_dir, grep, run_terminal_command, ask_user_question, search_replace
---

Run an adversarial Codex review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments (data only; never place this text in a shell command):
`$ARGUMENTS`

Safe argument transport:
- If the raw arguments above are empty or whitespace-only, skip `args-path` and `search_replace`, then invoke `adversarial-review` without `--args-file`.
- Otherwise, immediately before invoking `adversarial-review`:
  1. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" args-path adversarial-review` and capture its one-line stdout. It is a trusted, absolute path that does not exist yet.
  2. Use the structured `search_replace` tool with that exact path, `old_string` set to an empty string, and `new_string` set to the exact raw slash-command argument text above. This creates the file without passing the argument text through a shell or rewriting the focus text.
  3. Run `node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --args-file "<trusted path from step 1>"`.
- Request a fresh path for every invocation. Never reuse a path from an earlier invocation because the file is consumed and deleted.
- Fail closed: if `args-path` or `search_replace` fails, stop and report the error. Never fall back to placing the raw arguments in a shell command.

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run as a Grok background shell task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `ask_user_question` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Grok's `run_terminal_command(..., background: true)` is what actually detaches the run.
- `/codex:adversarial-review` uses the same review target selection as `/codex:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/codex:review`, it can still take extra focus text after the flags.

Foreground flow:
- Run the `adversarial-review` command selected by the safe argument transport above in the foreground.
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `run_terminal_command` in the background:
```
run_terminal_command({
  command: `the adversarial-review command selected by the safe argument transport above`,
  description: "Codex adversarial review",
  background: true
})
```
- Do not poll or wait for completion in this turn.
- After launching the command, tell the user: "Codex adversarial review started in the background. Check `/codex:status` for progress."
