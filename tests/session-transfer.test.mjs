import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  convertGrokChatHistoryToImportJsonl,
  resolveSessionTransferSource
} from "../plugins/codex/scripts/lib/session-transfer.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "grok-chat-history-with-tools.jsonl");

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function countTypes(rows) {
  const counts = {};
  for (const row of rows) {
    const key = row.type || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

test("convertGrokChatHistoryToImportJsonl preserves user, assistant, and tool substance", () => {
  const converted = convertGrokChatHistoryToImportJsonl(FIXTURE, {
    cwd: ROOT,
    title: "fixture-session"
  });
  const rows = parseJsonl(converted);
  const types = countTypes(rows);

  assert.equal(types["custom-title"], 1);
  assert.ok((types.user || 0) >= 2, `expected user turns including tool_result, got ${JSON.stringify(types)}`);
  assert.ok((types.assistant || 0) >= 2, `expected assistant turns, got ${JSON.stringify(types)}`);

  const joined = rows.map((row) => row.message?.content || "").join("\n");
  assert.match(joined, /list available tools/);
  assert.match(joined, /\[tool_call/);
  assert.match(joined, /search_tool/);
  assert.match(joined, /\[tool_result/);
  assert.match(joined, /mcphub__search_tools/);
  assert.match(joined, /Found search_tools/);
  assert.doesNotMatch(joined, /thinking about tools/);
});

test("convertGrokChatHistoryToImportJsonl keeps tool_results from a temp real-shaped sample", () => {
  const dir = makeTempDir("grok-transfer-");
  const source = path.join(dir, "chat_history.jsonl");
  fs.writeFileSync(
    source,
    [
      JSON.stringify({ type: "user", content: "run status" }),
      JSON.stringify({
        type: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "run_terminal_command", arguments: "{\"command\":\"git status\"}" }]
      }),
      JSON.stringify({
        type: "tool_result",
        tool_call_id: "c1",
        content: "On branch main\nnothing to commit"
      }),
      JSON.stringify({ type: "assistant", content: "Working tree is clean." })
    ].join("\n") + "\n",
    "utf8"
  );

  const rows = parseJsonl(convertGrokChatHistoryToImportJsonl(source, { cwd: dir, title: "tmp" }));
  const userTexts = rows.filter((r) => r.type === "user").map((r) => r.message.content);
  const assistantTexts = rows.filter((r) => r.type === "assistant").map((r) => r.message.content);

  assert.ok(userTexts.some((t) => t.includes("run status")));
  assert.ok(userTexts.some((t) => t.includes("[tool_result") && t.includes("nothing to commit")));
  assert.ok(assistantTexts.some((t) => t.includes("[tool_call") && t.includes("run_terminal_command")));
  assert.ok(assistantTexts.some((t) => t.includes("Working tree is clean")));
});

test("resolveSessionTransferSource stages under Codex convention without pre-existing Claude install", () => {
  const isolatedHome = makeTempDir("pure-grok-home-");
  const repo = path.join(isolatedHome, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevGrokHome = process.env.GROK_HOME;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GROK_HOME = path.join(isolatedHome, ".grok");

  try {
    assert.equal(fs.existsSync(path.join(isolatedHome, ".claude")), false);
    const group = encodeURIComponent(path.resolve(repo));
    const sessionDir = path.join(isolatedHome, ".grok", "sessions", group, "pure-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    const source = path.join(sessionDir, "chat_history.jsonl");
    fs.writeFileSync(
      source,
      [
        JSON.stringify({ type: "user", content: "pure grok transfer" }),
        JSON.stringify({ type: "assistant", content: "ok" })
      ].join("\n") + "\n",
      "utf8"
    );

    const result = resolveSessionTransferSource(repo, { source });
    assert.equal(result.host, "grok");
    assert.equal(result.converted, true);
    assert.match(result.importPath.replace(/\\/g, "/"), /\.claude\/projects\/-grok-codex-transfer\//);
    assert.equal(fs.existsSync(result.importPath), true);
    const body = fs.readFileSync(result.importPath, "utf8");
    assert.match(body, /pure grok transfer/);
    assert.match(body, /"type":"assistant"/);
  } finally {
    if (prevHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevProfile == null) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevProfile;
    }
    if (prevGrokHome == null) {
      delete process.env.GROK_HOME;
    } else {
      process.env.GROK_HOME = prevGrokHome;
    }
  }
});
