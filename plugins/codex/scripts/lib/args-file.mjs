import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ARGS_DIR_NAME = "args";
const FALLBACK_ARGS_DIR_NAME = "codex-companion-args";
const ARGS_FILE_MAX_BYTES = 64 * 1024;
const ARGS_FILE_MAX_AGE_MS = 60 * 60 * 1000;

function sanitizeFileNamePart(value, fallback) {
  const sanitized = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return sanitized || fallback;
}

function isInsideDir(parentDir, candidatePath) {
  const normalizeForComparison = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const relative = path.relative(
    normalizeForComparison(parentDir),
    normalizeForComparison(candidatePath)
  );
  return !(
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function pathsEqual(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function realpathArgsFile(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`\`--args-file\` path does not exist: ${filePath}`);
    }
    throw new Error(`Could not resolve \`--args-file\` path ${filePath}: ${error.message}`);
  }
}

function lstatArgsFile(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`\`--args-file\` path does not exist: ${filePath}`);
    }
    throw new Error(`Could not inspect \`--args-file\` path ${filePath}: ${error.message}`);
  }
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRegularArgsFile(stat) {
  if (stat.isSymbolicLink?.()) {
    throw new Error("`--args-file` path must refer to a regular file, not a symbolic link.");
  }
  if (!stat.isFile()) {
    throw new Error("`--args-file` path must refer to a regular file.");
  }
}

function readLimitedUtf8(descriptor) {
  const buffer = Buffer.allocUnsafe(ARGS_FILE_MAX_BYTES + 1);
  let bytesRead = 0;

  while (bytesRead < buffer.length) {
    const count = fs.readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      null
    );
    if (count === 0) {
      break;
    }
    bytesRead += count;
  }

  if (bytesRead > ARGS_FILE_MAX_BYTES) {
    throw new Error("`--args-file` exceeds the 64 KiB size limit.");
  }
  return buffer.subarray(0, bytesRead).toString("utf8");
}

export function resolveArgsDir(env = process.env) {
  const argsRoot = env?.GROK_PLUGIN_DATA
    ? path.join(env.GROK_PLUGIN_DATA, ARGS_DIR_NAME)
    : path.join(os.tmpdir(), FALLBACK_ARGS_DIR_NAME);
  return path.resolve(argsRoot);
}

export function ensureArgsDir(env = process.env) {
  const argsDir = resolveArgsDir(env);
  fs.mkdirSync(argsDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(argsDir, 0o700);
  }
  return argsDir;
}

export function cleanupStaleArgsFiles(argsDir, now = Date.now()) {
  try {
    for (const entry of fs.readdirSync(argsDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".txt")) {
        continue;
      }

      const candidatePath = path.join(argsDir, entry.name);
      try {
        const stat = fs.lstatSync(candidatePath);
        if (now - stat.mtimeMs > ARGS_FILE_MAX_AGE_MS) {
          fs.unlinkSync(candidatePath);
        }
      } catch {
        // Cleanup is best effort because another process may consume the file.
      }
    }
  } catch {
    // A cleanup failure must not prevent creation of a fresh argument path.
  }
}

export function createArgsPath(commandName, env = process.env) {
  const argsDir = ensureArgsDir(env);
  cleanupStaleArgsFiles(argsDir);
  const safeCommand = sanitizeFileNamePart(commandName, "command");
  const safeSession = sanitizeFileNamePart(
    env?.GROK_SESSION_ID || env?.CODEX_COMPANION_SESSION_ID || "nosession",
    "nosession"
  );
  return path.join(argsDir, `${safeCommand}-${safeSession}-${randomUUID()}.txt`);
}

export function readValidatedArgsFile(filePath, env = process.env) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("`--args-file` path must be absolute.");
  }

  const argsDir = ensureArgsDir(env);
  const canonicalArgsDir = fs.realpathSync(argsDir);
  const canonicalFile = realpathArgsFile(filePath);
  if (!isInsideDir(canonicalArgsDir, canonicalFile)) {
    throw new Error(
      `\`--args-file\` path must be inside the allowed arguments directory: ${argsDir}`
    );
  }

  const initialStat = lstatArgsFile(filePath);
  assertRegularArgsFile(initialStat);

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    try {
      descriptor = fs.openSync(filePath, openFlags);
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new Error(
          "`--args-file` path must refer to a regular file, not a symbolic link."
        );
      }
      if (error?.code === "ENOENT") {
        throw new Error(`\`--args-file\` path does not exist: ${filePath}`);
      }
      throw new Error(`Could not open \`--args-file\` path ${filePath}: ${error.message}`);
    }

    const openedStat = fs.fstatSync(descriptor);
    assertRegularArgsFile(openedStat);
    if (!isSameFile(initialStat, openedStat)) {
      throw new Error("`--args-file` changed during validation; refusing to read it.");
    }
    if (openedStat.size > ARGS_FILE_MAX_BYTES) {
      throw new Error("`--args-file` exceeds the 64 KiB size limit.");
    }

    const finalCanonicalFile = realpathArgsFile(filePath);
    const finalStat = lstatArgsFile(filePath);
    assertRegularArgsFile(finalStat);
    if (
      !pathsEqual(canonicalFile, finalCanonicalFile) ||
      !isInsideDir(canonicalArgsDir, finalCanonicalFile) ||
      !isSameFile(openedStat, finalStat)
    ) {
      throw new Error("`--args-file` changed during validation; refusing to read it.");
    }

    return readLimitedUtf8(descriptor);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function removeArgsFiles(filePaths) {
  for (const filePath of filePaths) {
    if (!filePath) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Consumption is one-shot; deletion remains best effort on every path.
    }
  }
}
