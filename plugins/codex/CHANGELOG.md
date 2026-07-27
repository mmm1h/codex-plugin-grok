# Changelog

## 1.1.0-grok

- Fork target: Grok Build first-class support (based on openai/codex-plugin-cc 1.0.6)
- Dual marketplace manifests: `.grok-plugin/` and `.claude-plugin/`
- Host env dual-read: `GROK_PLUGIN_*` preferred, `CLAUDE_PLUGIN_*` fallback
- Commands/agents rewritten for Grok tools (`run_terminal_command`, `spawn_subagent`, `ask_user_question`)
- Session transfer supports Grok `~/.grok/sessions/**/chat_history.jsonl` (auto-converts to Codex import format)
- Claude session transfer still works under `~/.claude/projects`
- App-server client name reports `Grok` when running under Grok

## 1.0.0

- Initial version of the Codex plugin for Claude Code
