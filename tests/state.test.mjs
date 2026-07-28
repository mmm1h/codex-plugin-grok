import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  isUsingFallbackStateDir,
  loadState,
  reconcileStaleJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  createJobProgressUpdater,
  queueBackgroundJob,
  readStoredJobWithRetry,
  runTrackedJob
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import {
  buildStatusSnapshot,
  resolveCancelableJob
} from "../plugins/codex/scripts/lib/job-control.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.GROK_PLUGIN_DATA;
  delete process.env.GROK_PLUGIN_DATA;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(isUsingFallbackStateDir(), true);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir != null) {
      process.env.GROK_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses GROK_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.GROK_PLUGIN_DATA;
  process.env.GROK_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(isUsingFallbackStateDir(), false);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.GROK_PLUGIN_DATA;
    } else {
      process.env.GROK_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("reconcileStaleJobs marks a dead running job stale in state and its job file", () => {
  const workspace = makeTempDir();
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const updatedAt = new Date(now - 31000).toISOString();
  const job = {
    id: "task-orphaned",
    status: "running",
    phase: "running",
    pid: 4321,
    createdAt: updatedAt,
    updatedAt
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [job]
  });
  const jobFile = writeJobFile(workspace, job.id, {
    ...job,
    request: { prompt: "continue the task" }
  });

  const result = reconcileStaleJobs(workspace, {
    now: () => now,
    isProcessAliveImpl: () => false
  });

  assert.deepEqual(result, { reconciled: 1, ids: [job.id] });
  const reconciled = loadState(workspace).jobs[0];
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.phase, "stale");
  assert.equal(reconciled.pid, null);
  assert.equal(reconciled.completedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(
    reconciled.errorMessage,
    "Codex job process is no longer running (orphaned); marked stale."
  );

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "stale");
  assert.equal(stored.pid, null);
  assert.deepEqual(stored.request, { prompt: "continue the task" });
});

test("reconcileStaleJobs leaves a new job alone during the grace period", () => {
  const workspace = makeTempDir();
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const updatedAt = new Date(now - 10000).toISOString();
  let probes = 0;
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-new",
        status: "queued",
        pid: null,
        createdAt: updatedAt,
        updatedAt
      }
    ]
  });

  const result = reconcileStaleJobs(workspace, {
    now,
    isProcessAliveImpl: () => {
      probes += 1;
      return false;
    }
  });

  assert.deepEqual(result, { reconciled: 0, ids: [] });
  assert.equal(probes, 0);
  assert.equal(loadState(workspace).jobs[0].status, "queued");
});

test("reconcileStaleJobs does not modify completed jobs", () => {
  const workspace = makeTempDir();
  const completed = {
    id: "task-completed",
    status: "completed",
    phase: "done",
    pid: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:01:00.000Z",
    completedAt: "2026-07-28T10:01:00.000Z"
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [completed]
  });

  const result = reconcileStaleJobs(workspace, {
    now: Date.parse("2026-07-28T12:00:00.000Z"),
    isProcessAliveImpl: () => {
      throw new Error("completed jobs must not be probed");
    }
  });

  assert.deepEqual(result, { reconciled: 0, ids: [] });
  assert.deepEqual(loadState(workspace).jobs[0], completed);
});

test("job-control readers stop treating an orphaned job as active", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-orphaned",
        status: "running",
        phase: "running",
        pid: 0,
        jobClass: "task",
        createdAt: "2020-01-01T10:00:00.000Z",
        updatedAt: "2020-01-01T10:00:01.000Z"
      }
    ]
  });

  assert.throws(
    () => resolveCancelableJob(workspace, "task-orphaned"),
    /No job found for "task-orphaned"/
  );
  const snapshot = buildStatusSnapshot(workspace);
  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished.id, "task-orphaned");
  assert.equal(snapshot.latestFinished.status, "failed");
  assert.equal(snapshot.latestFinished.phase, "stale");
});

test("queueBackgroundJob persists the request before spawning a worker", () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-queued",
    workspaceRoot: workspace,
    title: "Codex Task"
  };
  const request = { prompt: "do not lose this task" };
  let spawned = false;

  const queued = queueBackgroundJob(job, request, () => {
    spawned = true;
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
    assert.deepEqual(stored.request, request);
    assert.deepEqual(loadState(workspace).jobs.find((candidate) => candidate.id === job.id)?.request, request);
    return { pid: 1234 };
  });

  assert.equal(spawned, true);
  assert.equal(queued.queuedRecord.status, "queued");
  assert.equal(queued.queuedRecord.pid, null);
});

test("readStoredJobWithRetry survives controlled worker-first scheduling", async () => {
  let attempts = 0;
  let clock = 0;
  const expected = { id: "task-visible", request: { prompt: "eventually visible" } };

  const stored = await readStoredJobWithRetry("workspace", expected.id, {
    timeoutMs: 2000,
    retryIntervalMs: 50,
    now: () => clock,
    sleepImpl: async (milliseconds) => {
      clock += milliseconds;
    },
    readImpl() {
      attempts += 1;
      if (attempts === 1) {
        return null;
      }
      if (attempts === 2) {
        const error = new Error("not visible yet");
        error.code = "ENOENT";
        throw error;
      }
      return expected;
    }
  });

  assert.deepEqual(stored, expected);
  assert.equal(attempts, 3);
  assert.equal(clock, 100);
});

test("critical state writes fail closed when a live lock exceeds the budget", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-existing", status: "queued" });
  const lockFile = path.join(resolveStateDir(workspace), "state.lock");
  fs.writeFileSync(lockFile, "held-by-test", "utf8");

  try {
    assert.throws(
      () => updateState(workspace, (state) => state.jobs.push({ id: "task-unlocked" }), { lockTimeoutMs: 5 }),
      /refusing an unlocked state write/
    );
  } finally {
    fs.unlinkSync(lockFile);
  }

  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), ["task-existing"]);
});

test("progress lock timeout skips the update without interrupting job completion", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "task-sentinel", status: "completed" });
  const job = {
    id: "task-progress",
    workspaceRoot: workspace,
    title: "Codex Task"
  };
  const progress = createJobProgressUpdater(workspace, job.id, {
    stateOptions: { lockTimeoutMs: 5 }
  });

  const execution = await runTrackedJob(job, async () => {
    const lockFile = path.join(resolveStateDir(workspace), "state.lock");
    fs.writeFileSync(lockFile, "held-by-test", "utf8");
    try {
      assert.doesNotThrow(() => progress({ phase: "thinking", threadId: "thr-skipped" }));
    } finally {
      fs.unlinkSync(lockFile);
    }
    return {
      exitStatus: 0,
      threadId: "thr-complete",
      turnId: "turn-complete",
      summary: "completed after skipped progress",
      payload: { ok: true },
      rendered: "done\n"
    };
  });

  assert.equal(execution.exitStatus, 0);
  const jobs = loadState(workspace).jobs;
  assert.equal(jobs.find((candidate) => candidate.id === job.id)?.status, "completed");
  assert.equal(jobs.find((candidate) => candidate.id === job.id)?.threadId, "thr-complete");
  assert.equal(jobs.some((candidate) => candidate.id === "task-sentinel"), true);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.threadId, "thr-complete");
});

test("concurrent state writers retain every new job and artifact", async () => {
  const workspace = makeTempDir();
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const jobIds = Array.from({ length: 8 }, (_, index) => `task-concurrent-${index}`);

  await Promise.all(jobIds.map((jobId) => new Promise((resolve, reject) => {
    const script = [
      `import { upsertJob, writeJobFile } from ${JSON.stringify(stateModule)};`,
      `const workspace = ${JSON.stringify(workspace)};`,
      `const job = { id: ${JSON.stringify(jobId)}, status: "queued" };`,
      "writeJobFile(workspace, job.id, job);",
      "upsertJob(workspace, job);"
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`writer ${jobId} failed with ${code}: ${stderr}`));
      }
    });
  })));

  const savedIds = new Set(loadState(workspace).jobs.map((job) => job.id));
  assert.deepEqual(savedIds, new Set(jobIds));
  for (const jobId of jobIds) {
    assert.equal(fs.existsSync(resolveJobFile(workspace, jobId)), true);
  }
});

test("atomic state writes retry transient Windows rename errors", () => {
  const workspace = makeTempDir();
  const originalRenameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function transientRename(source, destination) {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("temporarily busy");
      error.code = attempts === 1 ? "EPERM" : "EBUSY";
      throw error;
    }
    return originalRenameSync.call(fs, source, destination);
  };

  try {
    writeJobFile(workspace, "task-rename", { id: "task-rename", status: "queued" });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(workspace, "task-rename"), "utf8")).status, "queued");
});
