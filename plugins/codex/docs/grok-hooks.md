# Grok hook contract

This document describes the fields the shipped hook code actually reads. The production contract is Grok camelCase; it is not a Claude Code dual-host contract.

## Environment

| Variable | Source and use |
|---|---|
| `GROK_PLUGIN_ROOT` | Injected by Grok. Absolute installed plugin directory used by `hooks/hooks.json` to launch scripts. |
| `GROK_PLUGIN_DATA` | Injected by Grok. Writable plugin data directory; SessionStart preserves it in `GROK_ENV_FILE` when that file is available. |
| `GROK_SESSION_ID` | Injected into Grok hook/agent processes. Fallback session identifier when stdin has no `sessionId`. |
| `GROK_HOME` | Optional override consumed by this plugin. If absent, session lookup uses `HOME`/`USERPROFILE`, then `os.homedir()`, plus `.grok`. |

SessionStart may export `CODEX_COMPANION_SESSION_ID`, `CODEX_COMPANION_TRANSCRIPT_PATH`, and `GROK_PLUGIN_DATA` through `GROK_ENV_FILE` so later commands in that Grok session can reuse them.

## Stdin JSON fields

| Field | Events | Resolution |
|---|---|---|
| `hookEventName` | SessionStart, SessionEnd | Used when the event name is not passed as argv. The shipped hook commands pass `SessionStart` or `SessionEnd` as argv. |
| `sessionId` | All | Preferred session id, ahead of `GROK_SESSION_ID` and `CODEX_COMPANION_SESSION_ID`. |
| `cwd` | All | Preferred workspace path. |
| `workspaceRoot` | All | Secondary cwd field. Environment fallbacks are `GROK_WORKSPACE_ROOT`, `GROK_PROJECT_DIR`, and `PWD`. |
| `transcriptPath` | SessionStart | Preferred explicit transcript path. |
| `transcript` | SessionStart | Secondary explicit transcript path. |
| `transcript_path` | SessionStart | Existing narrow compatibility alias for transcript lookup only. |
| `lastAssistantMessage` | Stop | Included in the optional stop-review prompt. |
| `reason` | Stop | Controls whether the review gate should run. |

`hook_event_name` and `session_id` are **not recognized** production fields. Do not send Claude-style snake_case for them. The `transcript_path` alias listed above is the only documented snake_case input in these resolvers.

Field names are strict, but lifecycle event values are tolerant: dispatch accepts `SessionStart`, `sessionStart`, or `session_start`, and the corresponding three `SessionEnd` spellings. The argv event passed by the shipped hook command takes precedence over `hookEventName`.

## Event behavior

### SessionStart

Resolves the session id and transcript. An explicit `transcriptPath` wins. Otherwise, when `sessionId` and cwd are available, the hook checks:

```text
~/.grok/sessions/<encodeURIComponent(path.resolve(cwd))>/<sessionId>/chat_history.jsonl
```

It exports the resolved companion session/transcript values through `GROK_ENV_FILE` when Grok provides that file.

Minimal fixture:

```json
{
  "hookEventName": "SessionStart",
  "sessionId": "session-123",
  "cwd": "/work/project",
  "transcriptPath": "/home/user/.grok/sessions/example/session-123/chat_history.jsonl"
}
```

### SessionEnd

Resolves cwd and session id, requests shutdown of the shared app-server broker, terminates queued/running jobs owned by that session, removes those jobs from plugin state, and clears the broker session files.

Minimal fixture:

```json
{
  "hookEventName": "SessionEnd",
  "sessionId": "session-123",
  "cwd": "/work/project"
}
```

### Stop

The Stop hook first applies `shouldRunStopReview(input)`:

- missing/empty `reason` or `reason: "end_turn"`: normal end-of-turn path; inspect current-session jobs and run the review gate when enabled.
- any other reason: observe-only session-close path; return immediately because Grok ignores a block decision during shutdown.

When the gate is disabled or Codex is unavailable, the hook only writes useful status/setup notes. When enabled, a failing review emits `{"decision":"block","reason":"..."}`. A clean review emits no decision.

The plugin review child has an internal timeout of 13 minutes. `hooks/hooks.json` gives Grok an outer timeout of about 900 seconds, leaving time to terminate the full child process tree and emit a decision before the host deadline.

Minimal fixture:

```json
{
  "hookEventName": "Stop",
  "sessionId": "session-123",
  "cwd": "/work/project",
  "lastAssistantMessage": "Implemented the requested change and ran tests.",
  "reason": "end_turn"
}
```

For an observe-only close fixture, change `reason` to a non-`end_turn` value such as `"shutdown"`.
