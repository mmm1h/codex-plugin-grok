import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Grok hook contract documents the fields and timing implemented by hook resolvers", () => {
  const docs = fs.readFileSync(path.join(ROOT, "plugins", "codex", "docs", "grok-hooks.md"), "utf8");

  for (const field of [
    "GROK_PLUGIN_ROOT",
    "GROK_PLUGIN_DATA",
    "GROK_SESSION_ID",
    "GROK_HOME",
    "hookEventName",
    "sessionId",
    "cwd",
    "workspaceRoot",
    "lastAssistantMessage",
    "transcriptPath",
    "reason"
  ]) {
    assert.match(docs, new RegExp(`\\b${field}\\b`), `missing ${field}`);
  }

  assert.match(docs, /`hook_event_name` and `session_id` are \*\*not recognized\*\*/);
  assert.match(docs, /SessionStart/);
  assert.match(docs, /SessionEnd/);
  assert.match(docs, /Stop/);
  assert.match(docs, /reason: "end_turn"/);
  assert.match(docs, /observe-only session-close/);
  assert.match(docs, /13 minutes/);
  assert.match(docs, /900 seconds/);
  assert.match(docs, /one Node process.*after every turn/i);
  assert.match(docs, /remove the Stop hook registration/i);
  assert.match(docs, /~\/\.grok\/sessions\/<encodeURIComponent\(path\.resolve\(cwd\)\)>\/<sessionId>\/chat_history\.jsonl/);
});
