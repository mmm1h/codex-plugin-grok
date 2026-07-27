# Changelog

## 1.1.0-grok

- Grok-only fork of openai/codex-plugin-cc (Claude Code users should use the official plugin)
- Marketplace manifest: `.grok-plugin/` only
- Host env: `GROK_PLUGIN_*` / `GROK_SESSION_ID` / Grok camelCase hook envelopes
- Hooks use `${GROK_PLUGIN_ROOT}` for SessionStart/End/Stop
- Commands/agents use Grok tools (`run_terminal_command`, `spawn_subagent`, `ask_user_question`)
- Session transfer for `~/.grok/sessions/**/chat_history.jsonl` (keeps tool_call / tool_result substance)
- App-server client name: `Grok`; service name: `grok_codex_plugin`

## 1.0.0

- Initial version of the Codex plugin for Claude Code
