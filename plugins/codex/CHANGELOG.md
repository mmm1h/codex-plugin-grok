# Changelog

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
