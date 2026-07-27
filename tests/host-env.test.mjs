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

test("resolveHostSessionId accepts Grok camelCase and GROK_SESSION_ID without companion export", async () => {
  const {
    resolveHostSessionId,
    resolveLastAssistantMessage
  } = await import("../plugins/codex/scripts/lib/host-env.mjs");

  assert.equal(
    resolveHostSessionId({ sessionId: "grok-sess" }, {}),
    "grok-sess"
  );
  assert.equal(
    resolveHostSessionId({ session_id: "claude-sess" }, {}),
    "claude-sess"
  );
  assert.equal(
    resolveHostSessionId({}, { GROK_SESSION_ID: "env-grok" }),
    "env-grok"
  );
  assert.equal(
    resolveHostSessionId({}, { CODEX_COMPANION_SESSION_ID: "env-companion" }),
    "env-companion"
  );
  // Prefer stdin sessionId over env
  assert.equal(
    resolveHostSessionId({ sessionId: "from-stdin" }, { GROK_SESSION_ID: "from-env" }),
    "from-stdin"
  );
  assert.equal(
    resolveLastAssistantMessage({ lastAssistantMessage: "hello from grok" }),
    "hello from grok"
  );
  assert.equal(
    resolveLastAssistantMessage({ last_assistant_message: "hello from claude" }),
    "hello from claude"
  );
});

test("SessionEnd cleans jobs using Grok camelCase sessionId without ENV_FILE", async () => {
  const { makeTempDir } = await import("./helpers.mjs");
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const { handleSessionEnd } = await import("../plugins/codex/scripts/session-lifecycle-hook.mjs");

  const workspace = makeTempDir("grok-session-end-");
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify(
      {
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
      },
      null,
      2
    ),
    "utf8"
  );

  // No GROK_ENV_FILE / CODEX_COMPANION_SESSION_ID — only Grok wire format.
  const env = {
    ...process.env,
    GROK_SESSION_ID: "grok-wire-sess",
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  };
  delete env.CODEX_COMPANION_SESSION_ID;
  delete env.GROK_ENV_FILE;
  delete env.CLAUDE_ENV_FILE;

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
  assert.equal(result.cleanup.cleaned, true);
  assert.equal(result.cleanup.removed, 1);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(
    state.jobs.map((job) => job.id),
    ["task-other-session"]
  );
});

test("SessionEnd cleans jobs when only GROK_SESSION_ID is present (empty stdin id)", async () => {
  const { makeTempDir } = await import("./helpers.mjs");
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const { handleSessionEnd } = await import("../plugins/codex/scripts/session-lifecycle-hook.mjs");

  const workspace = makeTempDir("grok-session-end-env-");
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-from-env",
            kind: "task",
            status: "completed",
            sessionId: "only-env-sess",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );

  const env = {
    ...process.env,
    GROK_SESSION_ID: "only-env-sess",
    GROK_PLUGIN_ROOT: PLUGIN_ROOT
  };
  delete env.CODEX_COMPANION_SESSION_ID;

  const result = await handleSessionEnd({ cwd: workspace }, env);
  assert.equal(result.sessionId, "only-env-sess");
  assert.equal(result.cleanup.removed, 1);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.length, 0);
});

test("stop-review gate reads Grok lastAssistantMessage and sessionId", async () => {
  const {
    buildStopReviewPrompt,
    filterJobsForCurrentSession
  } = await import("../plugins/codex/scripts/stop-review-gate-hook.mjs");

  const prompt = buildStopReviewPrompt({
    lastAssistantMessage: "I finished the refactor.",
    sessionId: "stop-sess"
  });
  assert.match(prompt, /I finished the refactor/);
  assert.doesNotMatch(prompt, /Previous host agent response:\s*$/);

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

  // Env-only Grok session when stdin omits id
  const envOnly = filterJobsForCurrentSession(
    [
      { id: "a", sessionId: "env-sess" },
      { id: "b", sessionId: "other" }
    ],
    {},
    { GROK_SESSION_ID: "env-sess" }
  );
  assert.deepEqual(
    envOnly.map((j) => j.id),
    ["a"]
  );
});

test("createJobRecord and companion session resolve via GROK_SESSION_ID", async () => {
  const { createJobRecord } = await import("../plugins/codex/scripts/lib/tracked-jobs.mjs");
  const job = createJobRecord(
    { id: "job-1", kind: "task", status: "queued" },
    { env: { GROK_SESSION_ID: "grok-live-sess" } }
  );
  assert.equal(job.sessionId, "grok-live-sess");

  // Drive companion status scoping with only GROK_SESSION_ID (no companion export).
  const { makeTempDir, run } = await import("./helpers.mjs");
  const { resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
  const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
  const workspace = makeTempDir("grok-status-scope-");
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify(
      {
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
      },
      null,
      2
    ),
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
