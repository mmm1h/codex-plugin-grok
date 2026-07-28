import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function envValue(env, name) {
  const entry = Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? "";
}

function windowsPathEntries(env) {
  return String(envValue(env, "PATH"))
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function findWindowsCommand(command, env) {
  const hasPath = path.isAbsolute(command) || command.includes("\\") || command.includes("/");
  const directories = hasPath ? [path.dirname(path.resolve(command))] : windowsPathEntries(env);
  const basename = hasPath ? path.basename(command) : command;
  const extension = path.extname(basename);
  const names = extension
    ? [basename]
    : [`${basename}.exe`, `${basename}.com`, `${basename}.cmd`, `${basename}.bat`, basename];

  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function isNodeScript(filePath) {
  try {
    const prefix = fs.readFileSync(filePath, "utf8").slice(0, 160);
    return /^#!.*\bnode(?:\.exe)?\b/im.test(prefix);
  } catch {
    return false;
  }
}

function resolveNodeShimEntrypoint(shimPath) {
  const directory = path.dirname(shimPath);
  const name = path.basename(shimPath, path.extname(shimPath)).toLowerCase();
  const candidates = [];

  if (name === "codex") {
    candidates.push(path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js"));
  } else if (name === "npm") {
    candidates.push(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
  }

  const extensionlessSibling = path.join(directory, name);
  if (isNodeScript(extensionlessSibling)) {
    candidates.unshift(extensionlessSibling);
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const CMD_META_CHARS = /([()%!^"<>&|])/g;

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(value) {
  let escaped = String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(CMD_META_CHARS, "^$1");
}

function explicitCmdInvocation(command, args, env) {
  const commandLine = [escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command: envValue(env, "ComSpec") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

/**
 * Resolve a command without relying on shell argument forwarding.
 * npm-generated codex/npm .cmd shims are launched through their JS entrypoint.
 */
export function resolveCommandInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false };
  }

  const resolved = findWindowsCommand(command, env);
  if (!resolved) {
    return { command, args, windowsVerbatimArguments: false };
  }

  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    const nodeEntrypoint = resolveNodeShimEntrypoint(resolved);
    if (nodeEntrypoint) {
      return {
        command: process.execPath,
        args: [nodeEntrypoint, ...args],
        windowsVerbatimArguments: false
      };
    }
    return explicitCmdInvocation(resolved, args, env);
  }

  if (!path.extname(resolved) && isNodeScript(resolved)) {
    return {
      command: process.execPath,
      args: [resolved, ...args],
      windowsVerbatimArguments: false
    };
  }

  return { command: resolved, args, windowsVerbatimArguments: false };
}

export function runCommand(command, args = [], options = {}) {
  const invocation = resolveCommandInvocation(command, args, {
    env: options.env,
    platform: options.platform
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function isProcessAlive(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  const killImpl = options.killImpl ?? process.kill.bind(process);
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }
    if (error?.code === "ESRCH") {
      return false;
    }
    return false;
  }
}

function looksLikeMissingProcessMessage(text) {
  // Include Chinese Windows taskkill messages ("找不到" / "不支持") and
  // common English variants so cancel/cleanup does not hard-fail mid-teardown.
  return /not found|no running instance|cannot find|does not exist|no such process|找不到|无法终止|不支持|access is denied|拒绝访问/i.test(
    text
  );
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    // taskkill can return non-zero for partial tree kills (e.g. protected
    // children) even when the target PID is gone. Treat as best-effort stop.
    if (!result.error && result.status !== 0) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
