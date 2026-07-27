import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  GROK_PLUGIN_ROOT_EXPR,
  expandPluginRootExpression,
  resolvePluginScriptPath,
  resolveHostSessionId,
  resolveLastAssistantMessage
} from "../plugins/codex/scripts/lib/host-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const HOOKS = path.join(PLUGIN_ROOT, "hooks", "hooks.json");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

test("Grok plugin root expression expands with GROK_PLUGIN_ROOT", () => {
  const expanded = expandPluginRootExpression(GROK_PLUGIN_ROOT_EXPR, {
    GROK_PLUGIN_ROOT: "D:\\plugin\\codex"
  });
  assert.equal(expanded, "D:\\plugin\\codex");
});

test("hooks.json uses GROK_PLUGIN_ROOT only", () => {
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
    assert.match(command, /\$\{GROK_PLUGIN_ROOT\}/);
    assert.doesNotMatch(command, /CLAUDE_PLUGIN_ROOT/);
  }
});

test("resolvePluginScriptPath requires GROK_PLUGIN_ROOT", () => {
  const grokPath = resolvePluginScriptPath("scripts/session-lifecycle-hook.mjs", {
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  });
  assert.equal(grokPath, path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs"));
  assert.equal(fs.existsSync(grokPath), true);
  assert.equal(resolvePluginScriptPath("scripts/session-lifecycle-hook.mjs", {}), null);
});

test("SessionStart hook runs with Grok plugin env", () => {
  const envFile = path.join(PLUGIN_ROOT, `.test-env-grok-${process.pid}`);
  try {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
    const result = spawnSync(process.execPath, [SESSION_HOOK, "SessionStart"], {
      cwd: ROOT,
      env: {
        ...process.env,
        GROK_PLUGIN_ROOT: PLUGIN_ROOT,
        GROK_PLUGIN_DATA: path.join(PLUGIN_ROOT, ".test-data"),
        GROK_ENV_FILE: envFile,
        GROK_SESSION_ID: "sess-grok-only"
      },
      input: JSON.stringify({
        hookEventName: "session_start",
        sessionId: "sess-grok-only",
        cwd: ROOT
      }),
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(envFile), true);
    const envBody = fs.readFileSync(envFile, "utf8");
    assert.match(envBody, /CODEX_COMPANION_SESSION_ID/);
    assert.match(envBody, /sess-grok-only/);
    assert.doesNotMatch(envBody, /CLAUDE_PLUGIN_DATA/);
  } finally {
    if (fs.existsSync(envFile)) {
      fs.unlinkSync(envFile);
    }
  }
});

test("resolveHostSessionId prefers Grok camelCase and GROK_SESSION_ID", () => {
  assert.equal(resolveHostSessionId({ sessionId: "grok-sess" }, {}), "grok-sess");
  assert.equal(resolveHostSessionId({}, { GROK_SESSION_ID: "env-grok" }), "env-grok");
  assert.equal(
    resolveHostSessionId({}, { CODEX_COMPANION_SESSION_ID: "env-companion" }),
    "env-companion"
  );
  assert.equal(
    resolveHostSessionId({ sessionId: "from-stdin" }, { GROK_SESSION_ID: "from-env" }),
    "from-stdin"
  );
  assert.equal(
    resolveLastAssistantMessage({ lastAssistantMessage: "hello from grok" }),
    "hello from grok"
  );
});

test("SessionEnd cleans jobs using Grok sessionId without ENV_FILE", async () => {
  const { makeTempDir } = await import("./helpers.mjs");
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const { handleSessionEnd } = await import("../plugins/codex/scripts/session-lifecycle-hook.mjs");

  const workspace = makeTempDir("grok-session-end-");
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "task-keep-alive",
          kind: "task",
          status: "completed",
          sessionId: "grok-wire-sess",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "task-other-session",
          kind: "task",
          status: "completed",
          sessionId: "other-sess",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const env = {
    ...process.env,
    GROK_SESSION_ID: "grok-wire-sess",
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  };
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.GROK_ENV_FILE;

  const result = await handleSessionEnd(
    {
      hookEventName: "session_end",
      sessionId: "grok-wire-sess",
      cwd: workspace,
      workspaceRoot: workspace
    },
    env
  );

  assert.equal(result.sessionId, "grok-wire-sess");
  assert.equal(result.cleanup.removed, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(
    state.jobs.map((job) => job.id),
    ["task-other-session"]
  );
});

test("stop-review gate reads Grok lastAssistantMessage and sessionId", async () => {
  const { buildStopReviewPrompt, filterJobsForCurrentSession } = await import(
    "../plugins/codex/scripts/stop-review-gate-hook.mjs"
  );

  const prompt = buildStopReviewPrompt({
    lastAssistantMessage: "I finished the refactor.",
    sessionId: "stop-sess"
  });
  assert.match(prompt, /I finished the refactor/);

  const filtered = filterJobsForCurrentSession(
    [
      { id: "a", sessionId: "stop-sess" },
      { id: "b", sessionId: "other" }
    ],
    { sessionId: "stop-sess" },
    { GROK_SESSION_ID: "stop-sess" }
  );
  assert.deepEqual(
    filtered.map((j) => j.id),
    ["a"]
  );
});

test("createJobRecord and companion status resolve via GROK_SESSION_ID", async () => {
  const { createJobRecord } = await import("../plugins/codex/scripts/lib/tracked-jobs.mjs");
  const job = createJobRecord(
    { id: "job-1", kind: "task", status: "queued" },
    { env: { GROK_SESSION_ID: "grok-live-sess" } }
  );
  assert.equal(job.sessionId, "grok-live-sess");

  const { makeTempDir, run } = await import("./helpers.mjs");
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
  const workspace = makeTempDir("grok-status-scope-");
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [
        {
          id: "review-current",
          kind: "review",
          kindLabel: "review",
          status: "completed",
          title: "Codex Review",
          jobClass: "review",
          sessionId: "grok-live-sess",
          summary: "current",
          createdAt: "2026-03-18T15:30:00.000Z",
          updatedAt: "2026-03-18T15:30:00.000Z"
        },
        {
          id: "review-other",
          kind: "review",
          kindLabel: "review",
          status: "completed",
          title: "Codex Review",
          jobClass: "review",
          sessionId: "other-sess",
          summary: "other",
          createdAt: "2026-03-18T15:20:00.000Z",
          updatedAt: "2026-03-18T15:21:00.000Z"
        }
      ]
    }),
    "utf8"
  );

  const env = {
    ...process.env,
    GROK_SESSION_ID: "grok-live-sess",
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  };
  delete env.CODEX_COMPANION_SESSION_ID;

  const result = run("node", [SCRIPT, "status"], { cwd: workspace, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review-current/);
  assert.doesNotMatch(result.stdout, /review-other/);
});
