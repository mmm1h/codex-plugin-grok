# Codex plugin for Grok Build

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), rewritten for **Grok Build** only.

This plugin is for Grok users who want Codex as a second pair of hands without leaving the Grok workflow. Claude Code users should install the official [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) instead.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs
- `codex:codex-rescue` subagent for proactive handoff from the main Grok agent

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key** (or your existing Codex provider profile, e.g. a configured `codex-api` profile)
  - Usage contributes to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**
- **Grok Build**
- Local `codex` CLI (`npm install -g @openai/codex`)

**You do not need Claude Code.** This plugin is Grok-only. Claude Code users should use [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

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

Local and marketplace installs are copied snapshots. After pulling a newer plugin version, refresh the installed copy before reloading:

```bash
grok plugin marketplace update codex-plugin-grok
grok plugin update codex
```

For local development, this repository can safely find the matching `codex-plugin-grok` installed snapshot from Grok's registry and show a dry-run:

```bash
npm run sync-installed
npm run sync-installed -- --apply
npm run sync-installed -- --deploy-user-plugin
npm run sync-installed -- --deploy-user-plugin --apply
```

The default target under `~/.grok/installed-plugins/` is Grok's marketplace-managed snapshot: syncing it keeps the installed package current, but that directory is not part of Grok's plugin discovery priority list. Add `--deploy-user-plugin` to also deploy this fork to `~/.grok/plugins/codex`, the user-level discovery location that wins over same-name plugins under `~/.claude/plugins/`. Both forms remain dry runs unless `--apply` is present.

Add `--update-marketplace` to refresh a copied local marketplace tree as well. If the marketplace already points at this checkout, the script leaves it alone and reports that only a reload is needed. The script never changes anything under `~/.claude/` and never reloads Grok automatically; reload plugins (`r` in the Plugins tab) or start a new session after `--apply`.

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

Slash entrypoints pass non-empty arguments through a one-shot args file created by Grok's structured `search_replace` tool. The raw slash text is never interpolated into a shell command, closing the command-injection surface from shell metacharacters; empty or whitespace-only calls take the direct fast path.

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

Creates a persistent Codex thread from the current Grok session and prints `codex resume <session-id>`.

**Source (Grok):** reads `~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl` and converts turns (including tool call/result summaries).

**Import staging (Codex path convention — not Claude Code):**

Codex's `externalAgentConfig/import` only records sessions that live under the Claude Code projects tree. Pure Grok machines do **not** need Claude Code installed. On first transfer the plugin auto-creates:

```text
~/.claude/projects/-grok-codex-transfer/grok-transfer-<sessionId>.jsonl
```

That folder is only a **temporary staging area** for Codex's import ledger. It is not dual-host support and does not require a Claude account or Claude CLI.

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

## Grok design notes

| Area | Behavior |
|------|----------|
| Host | **Grok Build only** (no Claude Code dual-host) |
| Plugin env | `GROK_PLUGIN_ROOT` / `GROK_PLUGIN_DATA` / `GROK_SESSION_ID` |
| Hook envelopes | Grok camelCase (`sessionId`, `lastAssistantMessage`, `hookEventName`) |
| Tools in commands/skills | `run_terminal_command`, `search_replace`, `spawn_subagent`, `ask_user_question` |
| Slash entrypoints | `commands/` + Grok-native `skills/<name>/SKILL.md`; non-empty arguments use the one-shot args-file channel |
| Background work | Slash review/rescue flows use Grok shell `background: true` for completion callbacks. Direct `task --background` is detached and must be checked with status/result |
| Session transfer | Source = Grok sessions; defaults to `~/.claude/projects/-grok-codex-transfer/` for the Codex 0.145.0 import convention, with `CODEX_TRANSFER_STAGING_DIR` available for compatible overrides |
| Plugin manifest | `plugins/codex/plugin.json` is the single root manifest read by Grok CLI |
| Marketplace layout | `.grok-plugin/marketplace.json` only |

The exact environment, stdin fields, event behavior, transcript layout, and Stop timeout contract are documented in [Grok hook contract](plugins/codex/docs/grok-hooks.md). In particular, production envelopes use Grok camelCase; `hook_event_name` and `session_id` are not recognized.

### Pure Grok machine checklist

| Need | Required? |
|------|-----------|
| Grok Build | Yes |
| Codex CLI + login/provider | Yes |
| This plugin | Yes |
| Claude Code app / Claude account | **No** |
| Pre-existing `~/.claude` | **No** (transfer creates the staging dir if needed) |

### FAQ

**Q: Why does transfer create a folder under `~/.claude`?**  
A: Codex CLI's session-import API historically only writes ledger entries for paths under `~/.claude/projects/…`. This plugin auto-creates `~/.claude/projects/-grok-codex-transfer/` as a **staging directory**. It is not Claude Code dual-host support and does not require installing Claude.

**Q: Do I need Claude Code for setup / review / rescue / status?**  
A: No. Those paths use only Grok env vars (`GROK_PLUGIN_*`, `GROK_SESSION_ID`) and the local `codex` CLI.

**Q: Slash commands show as `[claude]` or stay disabled?**  
A: On some Grok builds, plugin skills are tagged `[claude]` in `grok inspect`. If slash entries stay disabled, set in `~/.grok/config.toml`:

```toml
[compat.claude]
skills = true
```

That flag enables Claude-compat skill loading for plugin slash entries; it is not the same as installing Claude Code. Then reload plugins (`r` in the Plugins tab).

**Q: `grok inspect` resolves `codex` from `~/.claude/plugins/...` instead of `~/.grok/installed-plugins/...`?**

A: `~/.grok/installed-plugins/` is Grok's marketplace install location, but it is not in Grok's plugin discovery priority list. Grok also discovers Claude-compatible plugins under `~/.claude/plugins/`, and when two plugins share the `codex` name the higher-priority discovered copy wins. As a result, the marketplace snapshot under `~/.grok/installed-plugins/` cannot override the official Claude plugin.

Deploy this fork to Grok's user-level discovery directory, then reload plugins (`r` in the Plugins tab) or start a new session:

```bash
npm run sync-installed -- --deploy-user-plugin --apply
```

This writes the fork to `~/.grok/plugins/codex`, which is in Grok's priority table, is automatically trusted, and takes precedence over `~/.claude/plugins/`. You do not need to disable or uninstall the official Claude plugin: it can remain available to Claude Code while Grok selects this fork. `claude plugin disable` only changes Claude Code's enabled-plugin state and has no effect on Grok discovery.

Verify with `grok inspect --json`: the `codex` entry's `path` should point to `~/.grok/plugins/codex`. Its `provides.skills` should contain 11 skills for this fork rather than the official plugin's 3.

## Direct CLI (without slash commands)

Grok can also call the companion script or `codex exec` directly:

```bash
node "${GROK_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write "fix the failing test"
# short prompt as args:
codex exec -c model_reasoning_effort="medium" -C <repo> -o out.md "<task>"
```

The args-file transport above is specific to plugin slash entrypoints. Direct CLI usage keeps the positional argument form unchanged; when invoking it from your own shell, you remain responsible for that shell's quoting and escaping.

**Windows PowerShell note:** do **not** use bash stdin redirection (`codex exec ... - < spec.md`) — pwsh rejects `<`. Prefer a **portable** output dir (`<repo>/tmp/codex-out/`), not a machine-local path.

Bundled helper (recommended on Windows):

```powershell
# From the installed/plugin scripts directory, or a checkout of this repo:
pwsh -File plugins/codex/scripts/invoke-codex.ps1 -Repo <repo> -Prompt "fix the failing test" -Effort medium
pwsh -File plugins/codex/scripts/invoke-codex.ps1 -Repo <repo> -PromptFile <repo>/tmp/codex-out/spec.md -OutName job.md -Effort high
# Optional only when that named Codex profile exists:
pwsh -File plugins/codex/scripts/invoke-codex.ps1 -Repo <repo> -Prompt "review" -CodexProfile codex-api
```

The helper preserves Codex's configured reasoning effort unless `-Effort` is supplied explicitly. `-CodexProfile` (`-Profile` remains an alias) adds the named profile only when supplied. It prefers the npm `codex.cmd` shim on Windows so PowerShell execution policy does not block `codex.ps1`.

Or pipe manually:

```powershell
$out = Join-Path <repo> "tmp/codex-out"
New-Item -ItemType Directory -Force $out | Out-Null
Get-Content -Raw (Join-Path $out "spec.md") | codex exec -c model_reasoning_effort="medium" -C <repo> -o (Join-Path $out "out.md") -
```

## Develop / test

```bash
npm test
node scripts/bump-version.mjs --check
npm run sync-installed
grok plugin validate ./plugins/codex
```

## License

Apache-2.0 (same as upstream). See `LICENSE` and `NOTICE`.
