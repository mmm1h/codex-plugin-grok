# Codex plugin for Grok Build

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), adapted so **Grok Build** can call local Codex for code review and task delegation.

This plugin is for Grok users who want Codex as a second pair of hands without leaving the Grok workflow. Claude Code paths still work as a fallback.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- `codex:codex-rescue` subagent for proactive handoff from the main Grok agent

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key** (or your existing Codex provider profile, e.g. a configured `codex-api` profile)
  - Usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**
- **Grok Build** (or Claude Code as secondary host)
- Local `codex` CLI (`npm install -g @openai/codex`)

## Install in Grok

Add the marketplace:

```bash
grok plugin marketplace add mmm1h/codex-plugin-grok
```

Or from a local checkout:

```bash
grok plugin marketplace add /path/to/codex-plugin-grok
# example: grok plugin marketplace add D:/git-pjt/codex-plugin-grok
```

Install and trust the plugin:

```bash
grok plugin install codex --trust
```

Reload plugins (`r` in the Plugins tab, or start a new session), then run:

```bash
/codex:setup
```

`/codex:setup` reports whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet:

```bash
codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents` (or plugin agent list)

One simple first run:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work.

> [!NOTE]
> Multi-file reviews can take a while. Prefer `--background`.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

Read-only. Background runs: check `/codex:status`, cancel with `/codex:cancel`.

### `/codex:adversarial-review`

Challenge-style review of approach, design, and assumptions. Same target selection as `/codex:review`, plus optional focus text:

```bash
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
```

### `/codex:rescue`

Delegate diagnosis, implementation, or follow-up work to Codex via the `codex:codex-rescue` subagent.

```bash
/codex:rescue find why the login flow 500s after refresh
/codex:rescue --effort high --write fix the flaky auth test
/codex:rescue --resume keep going
/codex:rescue --model spark quick pass on this stacktrace
```

Notes:

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults
- `spark` maps to `gpt-5.3-codex-spark`
- example with explicit model/effort: `--model gpt-5.4-mini --effort medium`
- use `--resume` to continue a previous Codex task thread in this repo

### `/codex:transfer`

Creates a persistent Codex thread from the current host session and prints `codex resume <session-id>`.

- **Grok**: reads `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl` and converts turns for Codex import
- **Claude Code**: reads `~/.claude/projects/**/*.jsonl` natively

```bash
/codex:transfer
/codex:transfer --source ~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
```

### `/codex:status`

Show active and recent Codex jobs for this repository.

### `/codex:result`

Show the stored final output for a finished Codex job.

### `/codex:cancel`

Cancel an active background Codex job.

### `/codex:setup`

Check Codex readiness; optionally toggle the stop-time review gate:

```bash
/codex:setup
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

## Grok-specific design

| Area | Behavior |
|------|----------|
| Plugin env | Prefers `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA`; falls back to `CLAUDE_PLUGIN_*` (Grok sets both) |
| Tools in commands | `run_terminal_command`, `spawn_subagent`, `ask_user_question` |
| Background work | Prefer Grok shell `background: true` (has completion callbacks). Avoid relying only on companion `--background` detached workers for agent orchestration |
| Session transfer | Grok chat history auto-converted before Codex external import |
| Marketplace layout | `.grok-plugin/marketplace.json` (+ `.claude-plugin` for dual-host) |

## Direct CLI (without slash commands)

Grok can also call the companion script or `codex exec` directly:

```bash
node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write "fix the failing test"
# or
codex exec --profile codex-api -c model_reasoning_effort="medium" -C <repo> -o out.md "<task>"
```

## Install for Claude Code (optional)

This fork still understands Claude-compatible env vars and Claude session paths:

```bash
/plugin marketplace add mmm1h/codex-plugin-grok
/plugin install codex@codex-plugin-grok
```

## Develop / test

```bash
npm test
node scripts/bump-version.mjs --check
grok plugin validate ./plugins/codex
```

## License

Apache-2.0 (same as upstream). See `LICENSE` and `NOTICE`.
