import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_LOCK_TIMEOUT_MS = 2000;
const STATE_LOCK_STALE_MS = 10000;
const STATE_LOCK_RETRY_MIN_MS = 20;
const STATE_LOCK_RETRY_MAX_MS = 50;
const STALE_JOB_GRACE_PERIOD_MS = 30000;
const STALE_JOB_ERROR_MESSAGE =
  "Codex job process is no longer running (orphaned); marked stale.";
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function resolvePluginDataDir(env = process.env) {
  return env?.GROK_PLUGIN_DATA || null;
}

export function isUsingFallbackStateDir(env = process.env) {
  return !resolvePluginDataDir(env);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = resolvePluginDataDir();
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(WAIT_ARRAY, 0, 0, milliseconds);
}

function resolveStateLockFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

function removeLockIfStale(lockFile) {
  try {
    const lockStat = fs.statSync(lockFile);
    if (Date.now() - lockStat.mtimeMs <= STATE_LOCK_STALE_MS) {
      return false;
    }
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockFile = resolveStateLockFile(cwd);
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  while (true) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(descriptor, token, "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return { lockFile, token };
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          // The incomplete lock will be handled by timeout recovery if cleanup fails.
        }
      }
      if (error?.code !== "EEXIST") {
        return null;
      }
    }

    if (removeLockIfStale(lockFile)) {
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    const retryMs =
      STATE_LOCK_RETRY_MIN_MS +
      Math.floor(Math.random() * (STATE_LOCK_RETRY_MAX_MS - STATE_LOCK_RETRY_MIN_MS + 1));
    sleepSync(Math.min(retryMs, remainingMs));
  }
}

function releaseStateLock(lock) {
  try {
    if (fs.readFileSync(lock.lockFile, "utf8") === lock.token) {
      fs.unlinkSync(lock.lockFile);
    }
  } catch {
    // Another process may have recovered or replaced an expired lock.
  }
}

function withStateLock(cwd, operation) {
  const lock = acquireStateLock(cwd);
  if (!lock) {
    process.stderr.write(
      "Warning: timed out acquiring Codex state lock; continuing without cross-process locking.\n"
    );
  }

  try {
    return operation();
  } finally {
    if (lock) {
      releaseStateLock(lock);
    }
  }
}

function atomicWriteFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );

  try {
    fs.writeFileSync(temporaryFile, contents, "utf8");
    fs.renameSync(temporaryFile, filePath);
  } finally {
    try {
      removeFileIfExists(temporaryFile);
    } catch {
      // The rename already committed the write, or cleanup is best effort.
    }
  }
}

function saveStateUnlocked(cwd, state) {
  ensureStateDir(cwd);
  const providedJobs = Array.isArray(state.jobs) ? state.jobs : [];
  const nextJobs = pruneJobs(providedJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of providedJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  atomicWriteFile(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFile(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function reconcileStaleJobs(cwd, options = {}) {
  const nowValue = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const now = Number(nowValue);
  const completedAt = new Date(now).toISOString();
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive;
  const ids = [];

  withStateLock(cwd, () => {
    const state = loadState(cwd);
    state.jobs = state.jobs.map((job) => {
      if (job.status !== "queued" && job.status !== "running") {
        return job;
      }

      const lastUpdate = Date.parse(job.updatedAt ?? job.createdAt);
      if (now - lastUpdate < STALE_JOB_GRACE_PERIOD_MS) {
        return job;
      }

      const processAlive = Number.isFinite(job.pid) && isProcessAliveImpl(job.pid);
      if (processAlive) {
        return job;
      }

      const stalePatch = {
        status: "failed",
        phase: "stale",
        pid: null,
        completedAt,
        updatedAt: completedAt,
        errorMessage: STALE_JOB_ERROR_MESSAGE
      };
      const staleJob = {
        ...job,
        ...stalePatch
      };
      ids.push(job.id);

      const jobFile = resolveJobFile(cwd, job.id);
      if (fs.existsSync(jobFile)) {
        let storedJob = job;
        try {
          storedJob = readJobFile(jobFile);
        } catch {
          // Replace an unreadable stored record with the indexed job details.
        }
        try {
          writeJobFile(cwd, job.id, {
            ...storedJob,
            ...stalePatch
          });
        } catch {
          // State reconciliation must still complete if an artifact cannot be updated.
        }
      }

      return staleJob;
    });
    if (ids.length > 0) {
      saveStateUnlocked(cwd, state);
    }
  });

  return { reconciled: ids.length, ids };
}
