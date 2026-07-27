# Changelog

## 1.1.0-grok

- Fork target: Grok Build first-class support (based on openai/codex-plugin-cc 1.0.6)
- Dual marketplace manifests: `.grok-plugin/` and `.claude-plugin/`
- Host env dual-read: `GROK_PLUGIN_*` preferred, `CLAUDE_PLUGIN_*` fallback
- Hooks use `${GROK_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}` so Grok-only env resolves SessionStart/End/Stop
- Commands/agents rewritten for Grok tools (`run_terminal_command`, `spawn_subagent`, `ask_user_question`)
- Session transfer supports Grok `~/.grok/sessions/**/chat_history.jsonl` (auto-converts to Codex import format)
- Grok transfer retains user/assistant text plus tool_call and tool_result summaries (drops pure reasoning)
- Claude session transfer still works under `~/.claude/projects`
- App-server client name / service name report Grok when running under Grok
- Portable install docs (no machine-local absolute paths)

## 1.0.0

- Initial version of the Codex plugin for Claude Code
