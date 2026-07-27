import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Dual-host helpers for Grok Build and Claude Code.
 * Grok documents GROK_PLUGIN_ROOT / GROK_PLUGIN_DATA and also sets the
 * CLAUDE_PLUGIN_* aliases. Prefer Grok names, fall back to Claude names.
 */

/** Shell-style dual-host plugin root used in hooks.json command strings. */
export const DUAL_HOST_PLUGIN_ROOT_EXPR = "${GROK_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}";

/**
 * Expand a dual-host plugin-root expression the same way Grok/Claude hook
 * runners do for `${VAR}` / `${VAR:-default}` forms. Used by tests and by
 * helpers that need to resolve hook command templates without a shell.
 */
export function expandPluginRootExpression(expression, env = process.env) {
  const source = String(expression ?? "");
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, fallback, bare) => {
    const name = braced || bare;
    const value = env[name];
    if (value != null && String(value).trim() !== "") {
      return String(value);
    }
    if (braced && fallback != null) {
      // Fallback may itself be $OTHER or ${OTHER}
      if (fallback.startsWith("${") || fallback.startsWith("$")) {
        return expandPluginRootExpression(fallback, env);
      }
      return fallback;
    }
    return "";
  });
}

/**
 * Resolve the absolute path to a plugin script for hook invocation.
 * Prefers GROK_PLUGIN_ROOT, then CLAUDE_PLUGIN_ROOT.
 */
export function resolvePluginScriptPath(relativeScriptPath, env = process.env) {
  const root = firstDefinedEnvFrom(env, "GROK_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT");
  if (!root) {
    return null;
  }
  const rel = String(relativeScriptPath ?? "").replace(/^[/\\]+/, "");
  return path.join(root, rel);
}

function firstDefinedEnvFrom(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value != null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return null;
}

export function firstDefinedEnv(...names) {
  return firstDefinedEnvFrom(process.env, ...names);
}

export function resolvePluginRoot() {
  return firstDefinedEnv("GROK_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT");
}

export function resolvePluginDataDir() {
  return firstDefinedEnv("GROK_PLUGIN_DATA", "CLAUDE_PLUGIN_DATA");
}

export function resolveProjectDir(fallbackCwd) {
  return (
    firstDefinedEnv("GROK_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "PWD") ||
    fallbackCwd ||
    process.cwd()
  );
}

export function resolveHostEnvFile() {
  return firstDefinedEnv("GROK_ENV_FILE", "CLAUDE_ENV_FILE");
}

export function resolveHostName() {
  if (firstDefinedEnv("GROK_PLUGIN_ROOT", "GROK_HOME", "GROK_SESSION_ID")) {
    return "Grok";
  }
  if (firstDefinedEnv("CLAUDE_PLUGIN_ROOT", "CLAUDE_PROJECT_DIR")) {
    return "Claude Code";
  }
  if (fs.existsSync(path.join(os.homedir(), ".grok"))) {
    return "Grok";
  }
  return "Claude Code";
}

export function resolveUserHome() {
  // Prefer HOME so tests (and Unix) can isolate; then USERPROFILE (Windows); then os.homedir().
  return firstDefinedEnv("HOME", "USERPROFILE") || os.homedir();
}

export function resolveGrokHome() {
  return firstDefinedEnv("GROK_HOME") || path.join(resolveUserHome(), ".grok");
}

export function resolveClaudeHome() {
  return path.join(resolveUserHome(), ".claude");
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Export env vars into the host session env file when supported.
 * Grok may not always provide GROK_ENV_FILE; Claude uses CLAUDE_ENV_FILE.
 */
export function appendHostEnvVar(name, value) {
  const envFile = resolveHostEnvFile();
  if (!envFile || value == null || value === "") {
    return false;
  }
  fs.appendFileSync(envFile, `export ${name}=${shellEscape(value)}\n`, "utf8");
  return true;
}

/**
 * Resolve plugin.json for either Grok or Claude layout.
 */
export function resolvePluginManifestUrl(importMetaUrl) {
  const candidates = [
    new URL("../../.grok-plugin/plugin.json", importMetaUrl),
    new URL("../../.claude-plugin/plugin.json", importMetaUrl),
    new URL("../../plugin.json", importMetaUrl)
  ];
  for (const url of candidates) {
    try {
      const filePath = path.fileURLToPath ? path.fileURLToPath(url) : fileURLToPathCompat(url);
      if (fs.existsSync(filePath)) {
        return { url, path: filePath };
      }
    } catch {
      // keep looking
    }
  }
  return { url: candidates[1], path: null };
}

function fileURLToPathCompat(url) {
  // Node always has fileURLToPath; local helper avoids circular imports.
  return decodeURIComponent(String(url).replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1"));
}
