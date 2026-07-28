# Changelog

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
