import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { readStdinIfPiped, readStdinJson } from "../plugins/codex/scripts/lib/fs.mjs";
import {
  isProcessAlive,
  resolveCommandInvocation,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";

test("isProcessAlive returns true when the process probe succeeds", () => {
  let invocation = null;

  assert.equal(
    isProcessAlive(1234, {
      killImpl(pid, signal) {
        invocation = { pid, signal };
      }
    }),
    true
  );
  assert.deepEqual(invocation, { pid: 1234, signal: 0 });
});

test("isProcessAlive returns false for ESRCH", () => {
  assert.equal(
    isProcessAlive(1234, {
      killImpl() {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      }
    }),
    false
  );
});

test("isProcessAlive returns true for EPERM", () => {
  assert.equal(
    isProcessAlive(1234, {
      killImpl() {
        const error = new Error("denied");
        error.code = "EPERM";
        throw error;
      }
    }),
    true
  );
});

test("readStdinIfPiped skips unsupported stdin descriptors", () => {
  const originalFstatSync = fs.fstatSync;
  const originalReadFileSync = fs.readFileSync;
  let probed = false;
  let read = false;

  try {
    fs.fstatSync = () => {
      probed = true;
      return {
        isFIFO: () => false,
        isFile: () => false,
        isSocket: () => false
      };
    };
    fs.readFileSync = () => {
      read = true;
      throw new Error("stdin must not be read");
    };

    assert.equal(readStdinIfPiped(), "");
    assert.equal(probed, true);
    assert.equal(read, false);
  } finally {
    fs.fstatSync = originalFstatSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("readStdinIfPiped reads socket-backed stdin", () => {
  const originalFstatSync = fs.fstatSync;
  const originalReadFileSync = fs.readFileSync;

  try {
    fs.fstatSync = () => ({
      isFIFO: () => false,
      isFile: () => false,
      isSocket: () => true
    });
    fs.readFileSync = () => '{"sessionId":"socket-session"}';

    assert.equal(readStdinIfPiped(), '{"sessionId":"socket-session"}');
  } finally {
    fs.fstatSync = originalFstatSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("readStdinJson reads JSON supplied through spawnSync input", () => {
  const moduleUrl = new URL("../plugins/codex/scripts/lib/fs.mjs", import.meta.url).href;
  const source = [
    `import { readStdinJson } from ${JSON.stringify(moduleUrl)};`,
    "process.stdout.write(JSON.stringify(readStdinJson()));"
  ].join("\n");
  const input = { sessionId: "spawn-input-session", hookEventName: "session_start" };
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), input);
});

test("readStdinJson returns an empty object for empty or invalid JSON", () => {
  const originalFstatSync = fs.fstatSync;
  const originalReadFileSync = fs.readFileSync;
  const inputs = ["", "{invalid json"];

  try {
    fs.fstatSync = () => ({
      isFIFO: () => true,
      isFile: () => false
    });
    fs.readFileSync = () => inputs.shift();

    assert.deepEqual(readStdinJson(), {});
    assert.deepEqual(readStdinJson(), {});
  } finally {
    fs.fstatSync = originalFstatSync;
    fs.readFileSync = originalReadFileSync;
  }
});

test("resolveCommandInvocation maps a Windows codex npm shim to its Node entrypoint", () => {
  const binDir = makeTempDir("codex-process-shim-");
  const entrypoint = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(binDir, "codex.cmd"), "@echo off\r\n");

  const invocation = resolveCommandInvocation("codex", ["app-server"], {
    platform: "win32",
    env: {
      PATH: binDir
    }
  });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [entrypoint, "app-server"]);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test("resolveCommandInvocation maps an extensionless Node script to process.execPath", () => {
  const binDir = makeTempDir("codex-process-node-script-");
  const scriptPath = path.join(binDir, "fixture-tool");
  fs.writeFileSync(scriptPath, "#!/usr/bin/env node\n");

  const invocation = resolveCommandInvocation("fixture-tool", ["arg"], {
    platform: "win32",
    env: {
      PATH: binDir
    }
  });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [scriptPath, "arg"]);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

test("resolveCommandInvocation uses explicit cmd.exe for a non-Node batch file", () => {
  const binDir = makeTempDir("codex-process-batch-");
  const batchPath = path.join(binDir, "fixture-tool.cmd");
  fs.writeFileSync(batchPath, "@echo off\r\n");

  const invocation = resolveCommandInvocation("fixture-tool", ["space value", "a&b"], {
    platform: "win32",
    env: {
      PATH: binDir,
      ComSpec: "C:\\Windows\\System32\\cmd.exe"
    }
  });

  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /space value/);
  assert.match(invocation.args[3], /a\^&b/);
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test("resolveCommandInvocation leaves ordinary POSIX commands as argument arrays", () => {
  const invocation = resolveCommandInvocation("git", ["status", "--short"], {
    platform: "linux",
    env: {}
  });
  assert.deepEqual(invocation, {
    command: "git",
    args: ["status", "--short"],
    windowsVerbatimArguments: false
  });
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree treats partial Windows taskkill failures as best-effort stop", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        stderr: "错误: 无法终止 PID 1234 的进程。\n原因: 此操作不支持。",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
});
