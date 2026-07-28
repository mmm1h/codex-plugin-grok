#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  appendHostEnvVar,
  COMPANION_SESSION_ID_ENV,
  encodeGrokSessionGroup,
  resolveHookCwd,
  resolveHookEventName,
  resolveHookTranscriptPathField,
  resolveHostSessionId,
  resolvePluginDataDir
} from "./lib/host-env.mjs";

export const SESSION_ID_ENV = COMPANION_SESSION_ID_ENV;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

export function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return { cleaned: false, removed: 0 };
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return { cleaned: false, removed: 0 };
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return { cleaned: false, removed: 0 };
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
  return { cleaned: true, removed: removedJobs.length };
}

function resolveTranscriptPath(input, sessionId) {
  const explicit = resolveHookTranscriptPathField(input);
  if (explicit) {
    return explicit;
  }
  const cwd = resolveHookCwd(input);
  // Grok sessions live under ~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
  if (sessionId && cwd) {
    const encoded = encodeGrokSessionGroup(cwd);
    const candidate = [
      process.env.GROK_HOME,
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.grok` : null,
      process.env.HOME ? `${process.env.HOME}/.grok` : null
    ]
      .filter(Boolean)
      .map((home) => {
        const sep = home.includes("\\") ? "\\" : "/";
        return `${home}${sep}sessions${sep}${encoded}${sep}${sessionId}${sep}chat_history.jsonl`;
      });
    for (const pathCandidate of candidate) {
      if (pathCandidate && fs.existsSync(pathCandidate)) {
        return pathCandidate;
      }
    }
  }
  return null;
}

export function handleSessionStart(input, env = process.env) {
  const pluginData = resolvePluginDataDir();
  const sessionId = resolveHostSessionId(input, env);
  const transcriptPath = resolveTranscriptPath(input, sessionId);

  if (sessionId) {
    appendHostEnvVar(SESSION_ID_ENV, sessionId);
  }
  if (transcriptPath) {
    appendHostEnvVar(TRANSCRIPT_PATH_ENV, transcriptPath);
  }
  if (pluginData) {
    appendHostEnvVar("GROK_PLUGIN_DATA", pluginData);
  }
  return { sessionId, transcriptPath, pluginData };
}

export async function handleSessionEnd(input, env = process.env) {
  const cwd = resolveHookCwd(input, env);
  const sessionId = resolveHostSessionId(input, env);
  const brokerSession =
    loadBrokerSession(cwd) ??
    (env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: env[BROKER_ENDPOINT_ENV],
          pidFile: env[PID_FILE_ENV] ?? null,
          logFile: env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  const cleanup = cleanupSessionJobs(cwd, sessionId);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
  return { cwd, sessionId, cleanup };
}

async function main() {
  const input = readHookInput();
  const eventName = resolveHookEventName(input, process.argv[2] ?? "");

  if (eventName === "SessionStart" || eventName === "session_start" || eventName === "sessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd" || eventName === "session_end" || eventName === "sessionEnd") {
    await handleSessionEnd(input);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("session-lifecycle-hook.mjs") ||
    process.argv[1].endsWith("session-lifecycle-hook.js"));

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
