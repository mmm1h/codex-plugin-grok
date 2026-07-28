import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { readValidatedArgsFile } from "../plugins/codex/scripts/lib/args-file.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function buildArgsEnv(pluginDataDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    GROK_PLUGIN_DATA: pluginDataDir,
    GROK_SESSION_ID: "session/with unsafe chars"
  };
}

function requestArgsPath(commandName, env) {
  const result = run(process.execPath, [SCRIPT, "args-path", commandName], {
    cwd: ROOT,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function prepareReviewRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "initial\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n", "utf8");
  return repo;
}

test("args-path returns unique absolute paths without creating argument files", () => {
  const pluginDataDir = makeTempDir("codex-args-data-");
  const env = buildArgsEnv(pluginDataDir);

  const first = requestArgsPath("adversarial/review", env);
  const second = requestArgsPath("adversarial/review", env);

  assert.equal(path.isAbsolute(first), true);
  assert.equal(path.dirname(first), path.join(pluginDataDir, "args"));
  assert.match(path.basename(first), /^adversarial-review-session-with-unsafe-chars-/);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), false);
  assert.notEqual(first, second);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
  }

  const jsonResult = run(
    process.execPath,
    [SCRIPT, "args-path", "review", "--json"],
    { cwd: ROOT, env }
  );
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const jsonPath = JSON.parse(jsonResult.stdout).path;
  assert.equal(path.isAbsolute(jsonPath), true);
  assert.equal(fs.existsSync(jsonPath), false);

  const fallbackEnv = { ...process.env };
  delete fallbackEnv.GROK_PLUGIN_DATA;
  const fallback = requestArgsPath("review", fallbackEnv);
  assert.equal(path.dirname(fallback), path.join(os.tmpdir(), "codex-companion-args"));
  assert.equal(fs.existsSync(fallback), false);
});

test("usage advertises args-path and args-file on every supported command", () => {
  const result = run(process.execPath, [SCRIPT, "--help"], {
    cwd: ROOT,
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /args-path <command-name> \[--json\]/);
  for (const commandName of [
    "setup",
    "review",
    "adversarial-review",
    "task",
    "transfer",
    "status",
    "result",
    "cancel"
  ]) {
    const usageLine = result.stdout
      .split(/\r?\n/)
      .find((line) => line.includes(`codex-companion.mjs ${commandName} `));
    assert.match(usageLine ?? "", /\[--args-file <path>\]/);
  }
});

test("args-path removes stale txt files and preserves recent files", () => {
  const pluginDataDir = makeTempDir("codex-args-cleanup-");
  const env = buildArgsEnv(pluginDataDir);
  const argsDir = path.join(pluginDataDir, "args");
  requestArgsPath("review", env);

  const staleFile = path.join(argsDir, "stale.txt");
  const recentFile = path.join(argsDir, "recent.txt");
  fs.writeFileSync(staleFile, "old", "utf8");
  fs.writeFileSync(recentFile, "new", "utf8");
  const staleTime = new Date(Date.now() - 61 * 60 * 1000);
  fs.utimesSync(staleFile, staleTime, staleTime);

  requestArgsPath("status", env);

  assert.equal(fs.existsSync(staleFile), false);
  assert.equal(fs.readFileSync(recentFile, "utf8"), "new");
});

test("--args-file matches legacy raw positional parsing for options and focus text", () => {
  const repo = prepareReviewRepo();
  const directBinDir = makeTempDir();
  const fileBinDir = makeTempDir();
  const directPluginData = makeTempDir("codex-args-direct-");
  const filePluginData = makeTempDir("codex-args-file-");
  installFakeCodex(directBinDir);
  installFakeCodex(fileBinDir);
  const directEnv = buildArgsEnv(directPluginData, buildEnv(directBinDir));
  const fileEnv = buildArgsEnv(filePluginData, buildEnv(fileBinDir));
  const focusText =
    "challenge the \"caching\" design; it's broken, so don't rewrite C:\\src\\app or \\d+; " +
    "check $(whoami), `whoami`, and ; rm -rf /";
  const rawArguments = `--base main --background ${focusText}`;

  const direct = run(
    process.execPath,
    [SCRIPT, "adversarial-review", `--json ${rawArguments}`],
    { cwd: repo, env: directEnv }
  );
  const argsFile = requestArgsPath("adversarial-review", fileEnv);
  fs.writeFileSync(argsFile, rawArguments, "utf8");
  const fromFile = run(
    process.execPath,
    [SCRIPT, "adversarial-review", "--json", "--args-file", argsFile],
    { cwd: repo, env: fileEnv }
  );

  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.deepEqual(JSON.parse(fromFile.stdout), JSON.parse(direct.stdout));
  const directState = JSON.parse(
    fs.readFileSync(path.join(directBinDir, "fake-codex-state.json"), "utf8")
  );
  const fileState = JSON.parse(
    fs.readFileSync(path.join(fileBinDir, "fake-codex-state.json"), "utf8")
  );
  assert.equal(fileState.lastTurnStart.prompt, directState.lastTurnStart.prompt);
  assert.equal(fileState.lastTurnStart.prompt.includes(`User focus: ${focusText}\n`), true);
  assert.doesNotMatch(fileState.lastTurnStart.prompt, /--background/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("task args-file preserves the rescue task text exactly", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir("codex-task-args-");
  installFakeCodex(binDir);
  const env = buildArgsEnv(pluginDataDir, buildEnv(binDir));
  const argsFile = requestArgsPath("task", env);
  const taskText =
    "don't rewrite the \"task\" at C:\\src\\app or \\d+; " +
    "inspect $(whoami), `whoami`, and ; rm -rf /";
  fs.writeFileSync(argsFile, `--fresh ${taskText}`, "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "task", "--json", "--args-file", argsFile],
    { cwd: ROOT, env }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(argsFile), false);
  const fakeState = JSON.parse(
    fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")
  );
  assert.equal(fakeState.lastTurnStart.prompt, taskText);
});

test("args-file keeps job ids positional and --source paths as flag values", () => {
  const pluginDataDir = makeTempDir("codex-structured-args-");
  const env = buildArgsEnv(pluginDataDir);

  const statusArgsFile = requestArgsPath("status", env);
  fs.writeFileSync(statusArgsFile, "missing-job --json", "utf8");
  const status = run(
    process.execPath,
    [SCRIPT, "status", "--args-file", statusArgsFile],
    { cwd: ROOT, env }
  );
  assert.notEqual(status.status, 0);
  assert.match(status.stderr, /No job found for "missing-job"/);
  assert.doesNotMatch(status.stderr, /missing-job --json/);
  assert.equal(fs.existsSync(statusArgsFile), false);

  const sourcePath = path.join(makeTempDir("codex source path-"), "missing session.jsonl");
  const transferArgsFile = requestArgsPath("transfer", env);
  fs.writeFileSync(transferArgsFile, `--source "${sourcePath}" --json`, "utf8");
  const transfer = run(
    process.execPath,
    [SCRIPT, "transfer", "--args-file", transferArgsFile],
    { cwd: ROOT, env }
  );
  assert.notEqual(transfer.status, 0);
  assert.match(transfer.stderr, /Session file not found/);
  assert.match(transfer.stderr, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(transferArgsFile), false);
});

test("--args-file is deleted when parsing fails", () => {
  const pluginDataDir = makeTempDir("codex-args-parse-failure-");
  const env = buildArgsEnv(pluginDataDir);
  const argsFile = requestArgsPath("adversarial-review", env);
  fs.writeFileSync(argsFile, "--base", "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "adversarial-review", "--args-file", argsFile],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing value for --base/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("--args-file rejects paths outside the allowed directory without deleting them", () => {
  const pluginDataDir = makeTempDir("codex-args-outside-data-");
  const outsideDir = makeTempDir("codex-args-outside-");
  const outsideFile = path.join(outsideDir, "outside.txt");
  const env = buildArgsEnv(pluginDataDir);
  fs.writeFileSync(outsideFile, "--json", "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", outsideFile],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the allowed arguments directory/);
  assert.equal(fs.existsSync(outsideFile), true);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "--json");
});

test("--args-file rejects a sibling directory with the same path prefix", () => {
  const pluginDataDir = makeTempDir("codex-args-prefix-data-");
  const siblingDir = `${path.join(pluginDataDir, "args")}-escape`;
  const siblingFile = path.join(siblingDir, "outside.txt");
  const env = buildArgsEnv(pluginDataDir);
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(siblingFile, "--json", "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", siblingFile],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the allowed arguments directory/);
  assert.equal(fs.existsSync(siblingFile), true);
});

test(
  "--args-file containment remains case-sensitive on non-Windows platforms",
  { skip: process.platform === "win32" },
  () => {
    const parentDir = makeTempDir("codex-args-case-");
    const pluginDataDir = path.join(parentDir, "PluginData");
    const outsideDir = path.join(parentDir, "plugindata", "args");
    const outsideFile = path.join(outsideDir, "outside.txt");
    const env = buildArgsEnv(pluginDataDir);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "--json", "utf8");

    const result = run(
      process.execPath,
      [SCRIPT, "setup", "--args-file", outsideFile],
      { cwd: ROOT, env }
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the allowed arguments directory/);
    assert.equal(fs.existsSync(outsideFile), true);
  }
);

test("--args-file rejects symbolic links without unlinking them", (t) => {
  const pluginDataDir = makeTempDir("codex-args-symlink-");
  const env = buildArgsEnv(pluginDataDir);
  const linkPath = requestArgsPath("setup", env);
  const targetPath = path.join(path.dirname(linkPath), "target.txt");
  fs.writeFileSync(targetPath, "--json", "utf8");
  try {
    fs.symlinkSync(targetPath, linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "UNKNOWN") {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", linkPath],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular file, not a symbolic link/);
  assert.equal(fs.existsSync(linkPath), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), "--json");
});

test("--args-file rejects files larger than 64 KiB and deletes them", () => {
  const pluginDataDir = makeTempDir("codex-args-oversize-");
  const env = buildArgsEnv(pluginDataDir);
  const argsFile = requestArgsPath("setup", env);
  fs.writeFileSync(argsFile, Buffer.alloc(64 * 1024 + 1, 0x61));

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", argsFile],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /64 KiB size limit/);
  assert.equal(fs.existsSync(argsFile), false);
});

test("--args-file reports a clear error when the file does not exist", () => {
  const pluginDataDir = makeTempDir("codex-args-missing-");
  const env = buildArgsEnv(pluginDataDir);
  const argsFile = requestArgsPath("setup", env);

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", argsFile],
    { cwd: ROOT, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /path does not exist/);
});

test("--args-file refuses a file replaced between validation and open", (t) => {
  const pluginDataDir = makeTempDir("codex-args-race-");
  const env = buildArgsEnv(pluginDataDir);
  const argsFile = requestArgsPath("setup", env);
  const outsideFile = path.join(makeTempDir("codex-args-race-outside-"), "outside.txt");
  const probeLink = path.join(path.dirname(argsFile), "symlink-probe.txt");
  fs.writeFileSync(argsFile, "--json", "utf8");
  fs.writeFileSync(outsideFile, "secret", "utf8");
  try {
    fs.symlinkSync(outsideFile, probeLink, "file");
    fs.unlinkSync(probeLink);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "UNKNOWN") {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const originalOpenSync = fs.openSync;
  fs.openSync = function replaceBeforeOpen(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(argsFile)) {
      fs.unlinkSync(argsFile);
      fs.symlinkSync(outsideFile, argsFile, "file");
    }
    return originalOpenSync.call(fs, filePath, ...args);
  };

  try {
    assert.throws(
      () => readValidatedArgsFile(argsFile, env),
      /symbolic link|changed during validation/
    );
  } finally {
    fs.openSync = originalOpenSync;
    try {
      fs.unlinkSync(argsFile);
    } catch {
      // The test only needs to restore the patched fs method reliably.
    }
  }
});

test("--args-file rejects relative paths without deleting the file", () => {
  const pluginDataDir = makeTempDir("codex-args-relative-");
  const env = buildArgsEnv(pluginDataDir);
  const argsFile = requestArgsPath("setup", env);
  const argsDir = path.dirname(argsFile);
  const relativePath = path.basename(argsFile);
  fs.writeFileSync(argsFile, "--json", "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "setup", "--args-file", relativePath],
    { cwd: argsDir, env }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /path must be absolute/);
  assert.equal(fs.existsSync(argsFile), true);
});

test("shell metacharacters and malformed quoting remain inert focus data", () => {
  const repo = prepareReviewRepo();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir("codex-args-injection-");
  installFakeCodex(binDir);
  const env = buildArgsEnv(pluginDataDir, buildEnv(binDir));
  const argsFile = requestArgsPath("adversarial-review", env);
  const sentinel = path.join(makeTempDir("codex-args-sentinel-"), "executed.txt");
  const sentinelPath = sentinel.replaceAll("\\", "/");
  const rawArguments = [
    "inspect $(whoami) and `whoami`; rm -rf /",
    `$(node -e 'require("node:fs").writeFileSync("${sentinelPath}","executed")')`,
    '"unmatched quote',
    "after CRLF"
  ].join("\r\n");
  fs.writeFileSync(argsFile, rawArguments, "utf8");

  const result = run(
    process.execPath,
    [SCRIPT, "adversarial-review", "--args-file", argsFile],
    { cwd: repo, env }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.existsSync(argsFile), false);
  const fakeState = JSON.parse(
    fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")
  );
  const prompt = fakeState.lastTurnStart.prompt;
  assert.match(prompt, /\$\(whoami\)/);
  assert.match(prompt, /`whoami`/);
  assert.match(prompt, /; rm -rf \//);
  assert.match(prompt, /writeFileSync/);
  assert.match(prompt, /unmatched quote\r?\nafter CRLF/);
});

test("--args-file is wired to all eight commands and rejects direct positionals", () => {
  const pluginDataDir = makeTempDir("codex-args-conflict-");
  const env = buildArgsEnv(pluginDataDir);
  for (const commandName of [
    "review",
    "adversarial-review",
    "task",
    "transfer",
    "status",
    "result",
    "cancel",
    "setup"
  ]) {
    const argsFile = requestArgsPath(commandName, env);
    fs.writeFileSync(argsFile, "--json", "utf8");

    const result = run(
      process.execPath,
      [SCRIPT, commandName, "--args-file", argsFile, "extra positional"],
      { cwd: ROOT, env }
    );

    assert.notEqual(result.status, 0, commandName);
    assert.match(result.stderr, /cannot be combined with positional arguments/);
    assert.equal(fs.existsSync(argsFile), false);
  }
});
