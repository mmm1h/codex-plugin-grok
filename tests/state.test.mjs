import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  reconcileStaleJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  buildStatusSnapshot,
  resolveCancelableJob
} from "../plugins/codex/scripts/lib/job-control.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses GROK_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.GROK_PLUGIN_DATA;
  process.env.GROK_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

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

test("saveState with a stale snapshot does not delete a newer job's artifacts", () => {
  const workspace = makeTempDir();
  const firstJob = {
    id: "task-a",
    status: "completed",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:01:00.000Z"
  };
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs: [firstJob]
  });
  const staleSnapshot = loadState(workspace);

  const secondLogFile = resolveJobLogFile(workspace, "task-b");
  const secondJob = {
    id: "task-b",
    status: "running",
    pid: process.pid,
    logFile: secondLogFile,
    createdAt: "2026-07-28T10:02:00.000Z",
    updatedAt: "2026-07-28T10:02:01.000Z"
  };
  fs.writeFileSync(secondLogFile, "running\n", "utf8");
  const secondJobFile = writeJobFile(workspace, secondJob.id, secondJob);
  saveState(workspace, {
    ...staleSnapshot,
    jobs: [secondJob, ...staleSnapshot.jobs]
  });

  saveState(workspace, staleSnapshot);

  assert.equal(fs.existsSync(secondJobFile), true);
  assert.equal(fs.existsSync(secondLogFile), true);
});
