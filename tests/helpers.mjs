import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  clearBrokerSession,
  loadBrokerSession,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

const trackedBrokerSessions = new Map();

function envValue(env, name) {
  if (process.platform !== "win32") {
    return env?.[name] ?? null;
  }
  const entry = Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

function withPluginDataEnv(env, operation) {
  const name = "GROK_PLUGIN_DATA";
  const previousValue = process.env[name];
  const nextValue = envValue(env, name);

  if (nextValue) {
    process.env[name] = nextValue;
  } else {
    delete process.env[name];
  }

  try {
    return operation();
  } finally {
    if (previousValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previousValue;
    }
  }
}

function warnCleanup(action, error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Warning: failed to ${action} during test cleanup: ${detail}\n`);
}

function trackBrokerSession(cwd, env) {
  try {
    const session = withPluginDataEnv(env, () => loadBrokerSession(cwd));
    if (!session) {
      return;
    }
    const key = `${session.pid ?? "unknown"}:${session.sessionDir ?? session.pidFile ?? cwd}`;
    trackedBrokerSessions.set(key, { cwd, env, session });
  } catch (error) {
    warnCleanup("track broker session", error);
  }
}

function cleanupTrackedBrokerSessions() {
  const sessions = [...trackedBrokerSessions.values()];
  trackedBrokerSessions.clear();

  for (const { cwd, env, session } of sessions) {
    try {
      terminateProcessTree(session.pid);
    } catch (error) {
      warnCleanup(`terminate broker process tree ${session.pid ?? "unknown"}`, error);
    }

    try {
      teardownBrokerSession(session);
    } catch (error) {
      warnCleanup(`remove broker artifacts for ${session.pid ?? "unknown"}`, error);
    }

    try {
      withPluginDataEnv(env, () => clearBrokerSession(cwd));
    } catch (error) {
      warnCleanup(`clear broker session for ${cwd}`, error);
    }
  }
}

after(cleanupTrackedBrokerSessions);

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: false,
    windowsHide: true
  });

  if (options.cwd && options.env) {
    trackBrokerSession(options.cwd, options.env);
  }
  return result;
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
