import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  DUAL_HOST_PLUGIN_ROOT_EXPR,
  expandPluginRootExpression,
  resolvePluginScriptPath
} from "../plugins/codex/scripts/lib/host-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const HOOKS = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

test("dual-host plugin root expression expands with Grok-only env", () => {
  const expanded = expandPluginRootExpression(DUAL_HOST_PLUGIN_ROOT_EXPR, {
    GROK_PLUGIN_ROOT: "D:\\plugin\\codex"
  });
  assert.equal(expanded, "D:\\plugin\\codex");
});

test("dual-host plugin root expression expands with Claude-only env", () => {
  const expanded = expandPluginRootExpression(DUAL_HOST_PLUGIN_ROOT_EXPR, {
    CLAUDE_PLUGIN_ROOT: "C:\\claude\\codex"
  });
  assert.equal(expanded, "C:\\claude\\codex");
});

test("dual-host plugin root prefers Grok when both are set", () => {
  const expanded = expandPluginRootExpression(DUAL_HOST_PLUGIN_ROOT_EXPR, {
    GROK_PLUGIN_ROOT: "D:\\grok\\codex",
    CLAUDE_PLUGIN_ROOT: "C:\\claude\\codex"
  });
  assert.equal(expanded, "D:\\grok\\codex");
});

test("hooks.json uses dual-host root expression for every command", () => {
  const hooks = JSON.parse(fs.readFileSync(HOOKS, "utf8"));
  const commands = [];
  for (const event of Object.values(hooks.hooks)) {
    for (const group of event) {
      for (const hook of group.hooks) {
        if (hook.type === "command") {
          commands.push(hook.command);
        }
      }
    }
  }
  assert.ok(commands.length >= 3);
  for (const command of commands) {
    assert.match(command, /\$\{GROK_PLUGIN_ROOT:-\$CLAUDE_PLUGIN_ROOT\}/);
    assert.doesNotMatch(command, /node "\$\{CLAUDE_PLUGIN_ROOT\}\//);
  }
});

test("resolvePluginScriptPath works for Grok-only and Claude-only env", () => {
  const grokPath = resolvePluginScriptPath("scripts/session-lifecycle-hook.mjs", {
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  });
  const claudePath = resolvePluginScriptPath("scripts/session-lifecycle-hook.mjs", {
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT
  });
  assert.equal(grokPath, path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs"));
  assert.equal(claudePath, path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs"));
  assert.equal(fs.existsSync(grokPath), true);
});

test("SessionStart hook runs with Grok-only plugin env (no CLAUDE_PLUGIN_ROOT)", () => {
  const envFile = path.join(PLUGIN_ROOT, `.test-env-grok-${process.pid}`);
  try {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
    const result = spawnSync(
      process.execPath,
      [SESSION_HOOK, "SessionStart"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          GROK_PLUGIN_ROOT: PLUGIN_ROOT,
          GROK_PLUGIN_DATA: path.join(PLUGIN_ROOT, ".test-data"),
          GROK_ENV_FILE: envFile,
          GROK_SESSION_ID: "sess-grok-only",
          CLAUDE_PLUGIN_ROOT: "",
          CLAUDE_PLUGIN_DATA: "",
          CLAUDE_ENV_FILE: ""
        },
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "sess-grok-only",
          cwd: ROOT
        }),
        encoding: "utf8",
        windowsHide: true
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(envFile), true);
    const envBody = fs.readFileSync(envFile, "utf8");
    assert.match(envBody, /CODEX_COMPANION_SESSION_ID/);
    assert.match(envBody, /sess-grok-only/);
  } finally {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
  }
});

test("SessionStart hook runs with Claude-only plugin env (no GROK_PLUGIN_ROOT)", () => {
  const envFile = path.join(PLUGIN_ROOT, `.test-env-claude-${process.pid}`);
  try {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
    const result = spawnSync(
      process.execPath,
      [SESSION_HOOK, "SessionStart"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
          CLAUDE_PLUGIN_DATA: path.join(PLUGIN_ROOT, ".test-data"),
          CLAUDE_ENV_FILE: envFile,
          GROK_PLUGIN_ROOT: "",
          GROK_PLUGIN_DATA: "",
          GROK_ENV_FILE: ""
        },
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "sess-claude-only",
          cwd: ROOT
        }),
        encoding: "utf8",
        windowsHide: true
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(envFile), true);
    const envBody = fs.readFileSync(envFile, "utf8");
    assert.match(envBody, /sess-claude-only/);
  } finally {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
  }
});
