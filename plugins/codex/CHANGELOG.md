# Changelog

## 1.2.0-grok

### Behavior changes

- `/codex:cancel`, `/codex:result`, `/codex:status`, and `/codex:transfer` now use model-mediated flows instead of bang-exec while preserving `disable-model-invocation`; parameterized calls add one tool round trip, and no-argument calls keep the fast path
- `invoke-codex.ps1` no longer injects `model_reasoning_effort=medium` by default and only overrides reasoning effort when `-Effort` is explicit
- `-Profile` is now `-CodexProfile` (`-Profile` remains an alias), and the launcher preserves the Codex process exit code
- Focus parsing consumes known flags first and preserves all remaining text verbatim, including apostrophes, embedded quotes, Windows paths, and regular expressions

### Security

- Keep slash-command arguments out of shell interpolation by writing them through `search_replace` to an args file and consuming them as structured data with `--args-file`
- Harden args-file validation against symlink and path-swap races with `O_NOFOLLOW`, descriptor identity checks, and non-destructive handling of rejected paths

### Reliability

- Reconcile orphaned jobs after a 30-second grace period so stale workers no longer block `--resume-last`
- Protect `state.json` with a cross-process lock and atomic writes; critical writes fail closed while progress updates skip instead of overwriting unlocked state
- Persist job records before spawning detached workers, guard stdin reads with `fstat`, and retain broker diagnostics when startup timeout cleanup terminates the process tree
- Retry Windows renames on `EPERM` and `EBUSY`, and ensure the test suite cleans up detached broker processes

### Engineering

- Run CI on pushes to `main` and pull requests across Ubuntu and Windows
- Add dependency-free plugin validation, version checks, ESLint, full `.mjs` typechecking, `.gitattributes`, and `.editorconfig`
- Expand the suite from 122 to 179 tests, covering 22 existing defects and 9 additional review findings; validate the args-file flow end to end on Grok 0.2.112

## 1.1.3-grok

- Add a registry-aware, dry-run-by-default script to sync local source changes into matching Grok installed snapshots and optional marketplace copies
- Document the exact Grok hook env/stdin contract, lifecycle behavior, transcript layout, Stop reasons, and nested timeouts
- Remove Node 24 `DEP0190` hotspots by resolving Windows npm shims to Node entrypoints and keeping child-process arguments shell-free

## 1.1.2-grok

- Stop review gate ignores Grok's observe-only session-close event, keeps its internal timeout below Grok's outer deadline, and terminates timed-out process trees
- SessionStart and transfer now share resolved cwd encoding; manifest URL loading uses Node's UNC-safe URL parser
- Windows launcher preserves the configured reasoning effort unless `-Effort` is explicit, only adds a profile when `-Profile` is explicit, and prefers `codex.cmd`
- Build type generation now uses a cross-platform Node launcher instead of POSIX `mkdir -p`
- Runtime tests use Grok camelCase hook envelopes and cover hook-event dispatch without argv fallbacks

## 1.1.1-grok

- Portable Windows launcher: `scripts/invoke-codex.ps1` (pipe stdin, repo-local `tmp/codex-out`, no machine-hardcoded paths)
- Docs: pure-Grok FAQ, PowerShell `<` redirection pitfall, portable out-dir guidance
- Naming scrub: session scoping / import convert helpers use Grok-Codex terminology

## 1.1.0-grok

- Grok-only fork of openai/codex-plugin-cc (Claude Code users should use the official plugin)
- Marketplace manifest: `.grok-plugin/` only
- Host env: `GROK_PLUGIN_*` / `GROK_SESSION_ID` / Grok camelCase hook envelopes
- Session scoping APIs use Grok naming (`getCurrentSessionId`, not Claude-as-host labels)
- Hooks use `${GROK_PLUGIN_ROOT}` for SessionStart/End/Stop
- Slash entrypoints shipped as Grok-native skills (`skills/<name>/SKILL.md`) plus `commands/`
- Commands/agents use Grok tools (`run_terminal_command`, `spawn_subagent`, `ask_user_question`)
- Session transfer for `~/.grok/sessions/**/chat_history.jsonl` (keeps tool_call / tool_result substance)
- Convert helper: `convertGrokChatHistoryToImportJsonl` (Codex import format; not dual-host)
- Transfer stages under `~/.claude/projects/-grok-codex-transfer/` (Codex path convention; auto-created; no Claude app)
- Import ledger path matching normalizes Windows `\\?\` prefixes
- App-server client name: `Grok`; service name: `grok_codex_plugin`
- README FAQ: pure-Grok requirements + staging path + optional `compat.claude.skills` for slash loading

## 1.0.0

- Initial version of the Codex plugin for Claude Code
