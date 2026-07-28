import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BROKER_STARTUP_TIMEOUT_MS,
  resolveBrokerStartupTimeoutMs,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

function makeBrokerArtifacts() {
  const sessionDir = makeTempDir("broker-lifecycle-");
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const residualFile = path.join(sessionDir, "nested", "residual.txt");
  fs.mkdirSync(path.dirname(residualFile), { recursive: true });
  fs.writeFileSync(pidFile, "123\n", "utf8");
  fs.writeFileSync(logFile, "diagnostic\n", "utf8");
  fs.writeFileSync(residualFile, "residual\n", "utf8");
  return { sessionDir, pidFile, logFile, residualFile };
}

test("teardownBrokerSession preserves the log and session directory when requested", () => {
  const artifacts = makeBrokerArtifacts();

  teardownBrokerSession({ ...artifacts, preserveLog: true });

  assert.equal(fs.existsSync(artifacts.pidFile), false);
  assert.equal(fs.existsSync(artifacts.logFile), true);
  assert.equal(fs.existsSync(artifacts.residualFile), true);
  assert.equal(fs.existsSync(artifacts.sessionDir), true);
  fs.rmSync(artifacts.sessionDir, { recursive: true, force: true });
});

test("teardownBrokerSession recursively removes all broker artifacts by default", () => {
  const artifacts = makeBrokerArtifacts();

  teardownBrokerSession(artifacts);

  assert.equal(fs.existsSync(artifacts.sessionDir), false);
});

test("resolveBrokerStartupTimeoutMs accepts a positive environment override", () => {
  assert.equal(
    resolveBrokerStartupTimeoutMs({ CODEX_BROKER_STARTUP_TIMEOUT_MS: "7500" }),
    7500
  );
  assert.equal(
    resolveBrokerStartupTimeoutMs({ CODEX_BROKER_STARTUP_TIMEOUT_MS: "invalid" }),
    DEFAULT_BROKER_STARTUP_TIMEOUT_MS
  );
});
