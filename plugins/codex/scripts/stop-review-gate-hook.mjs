#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { readStdinJson } from "./lib/fs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, reconcileStaleJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  resolveHookCwd,
  resolveHostSessionId,
  resolveLastAssistantMessage
} from "./lib/host-env.mjs";

// Leave enough headroom for this hook to emit a block decision before Grok's
// outer 900-second hook deadline fires.
const STOP_REVIEW_TIMEOUT_MS = 13 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Grok turn.";

function readHookInput() {
  return readStdinJson();
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

export function shouldRunStopReview(input = {}) {
  const reason = String(input?.reason ?? "").trim();
  // Grok emits an observe-only Stop while the session is closing. Its decision
  // is ignored, so starting a Codex review there only delays shutdown.
  return !reason || reason === "end_turn";
}

function filterJobsForCurrentSession(jobs, input = {}, env = process.env) {
  const sessionId = resolveHostSessionId(input, env);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = resolveLastAssistantMessage(input);
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const hostResponseBlock = lastAssistantMessage
    ? ["Previous host agent response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    HOST_RESPONSE_BLOCK: hostResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

export async function runStopReview(cwd, input = {}, env = process.env, options = {}) {
  const scriptPath = options.scriptPath ?? path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const sessionId = resolveHostSessionId(input, env);
  const childEnv = {
    ...env,
    ...(sessionId
      ? {
          [SESSION_ID_ENV]: sessionId,
          GROK_SESSION_ID: env.GROK_SESSION_ID || sessionId
        }
      : {})
  };
  const timeoutMs = options.timeoutMs ?? STOP_REVIEW_TIMEOUT_MS;
  const terminateTree = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const child = spawn(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (fields) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...fields });
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (status, signal) => finish({ status, signal, error: null }));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        terminateTree(child.pid, { cwd, env: childEnv });
      } catch {
        // The direct-child kill below is still required as a fallback.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited while timeout cleanup was running.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ status: null, signal: "SIGTERM", error: null });
    }, timeoutMs);
  });

  if (result.timedOut) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out before Grok's hook deadline. Its process tree was terminated; run /codex:review --wait manually or bypass the gate."
    };
  }

  if (result.error) {
    return {
      ok: false,
      reason: `The stop-time Codex review task failed to start: ${result.error.message}`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

async function main() {
  const input = readHookInput();
  if (!shouldRunStopReview(input)) {
    return;
  }
  const cwd = resolveHookCwd(input);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileStaleJobs(workspaceRoot);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = await runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

// Exported for unit tests (Grok camelCase envelope coverage).
export {
  filterJobsForCurrentSession,
  buildStopReviewPrompt,
  resolveHostSessionId,
  resolveLastAssistantMessage
};

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("stop-review-gate-hook.mjs") ||
    process.argv[1].endsWith("stop-review-gate-hook.js"));

if (isDirectRun) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
