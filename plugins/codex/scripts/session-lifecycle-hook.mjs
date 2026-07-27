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
import { appendHostEnvVar, resolvePluginDataDir } from "./lib/host-env.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
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
}

function resolveTranscriptPath(input) {
  if (input.transcript_path) {
    return input.transcript_path;
  }
  // Grok sessions live under ~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
  if (input.session_id && input.cwd) {
    const encoded = encodeURIComponent(String(input.cwd));
    const grokHome = process.env.GROK_HOME || `${process.env.USERPROFILE || process.env.HOME || ""}/.grok`.replace(/\\/g, "\\");
    // Prefer path.join style via string concat for hook simplicity across hosts.
    const candidate = [
      process.env.GROK_HOME,
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.grok` : null,
      process.env.HOME ? `${process.env.HOME}/.grok` : null
    ]
      .filter(Boolean)
      .map((home) => {
        const sep = home.includes("\\") ? "\\" : "/";
        return `${home}${sep}sessions${sep}${encoded}${sep}${input.session_id}${sep}chat_history.jsonl`;
      });
    for (const pathCandidate of candidate) {
      if (pathCandidate && fs.existsSync(pathCandidate)) {
        return pathCandidate;
      }
    }
  }
  return null;
}

function handleSessionStart(input) {
  const pluginData = resolvePluginDataDir();
  const sessionId =
    input.session_id ||
    process.env.GROK_SESSION_ID ||
    process.env.CODEX_COMPANION_SESSION_ID ||
    null;
  const transcriptPath = resolveTranscriptPath({ ...input, session_id: sessionId });

  if (sessionId) {
    appendHostEnvVar(SESSION_ID_ENV, sessionId);
  }
  if (transcriptPath) {
    appendHostEnvVar(TRANSCRIPT_PATH_ENV, transcriptPath);
  }
  if (pluginData) {
    // Export both names so downstream scripts work on either host.
    appendHostEnvVar("GROK_PLUGIN_DATA", pluginData);
    appendHostEnvVar("CLAUDE_PLUGIN_DATA", pluginData);
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
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

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
