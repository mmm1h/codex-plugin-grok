import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Grok Build host helpers.
 * This fork targets Grok only; Claude Code users should use openai/codex-plugin-cc.
 */

/** Plugin root expression used in hooks.json command strings. */
export const GROK_PLUGIN_ROOT_EXPR = "${GROK_PLUGIN_ROOT}";

/**
 * Expand `${VAR}` / `$VAR` / `${VAR:-default}` the same way Grok hook runners do.
 */
export function expandPluginRootExpression(expression, env = process.env) {
  const source = String(expression ?? "");
  return source.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, fallback, bare) => {
      const name = braced || bare;
      const value = env[name];
      if (value != null && String(value).trim() !== "") {
        return String(value);
      }
      if (braced && fallback != null) {
        if (fallback.startsWith("${") || fallback.startsWith("$")) {
          return expandPluginRootExpression(fallback, env);
        }
        return fallback;
      }
      return "";
    }
  );
}

/**
 * Resolve the absolute path to a plugin script under GROK_PLUGIN_ROOT.
 */
export function resolvePluginScriptPath(relativeScriptPath, env = process.env) {
  const root = firstDefinedEnvFrom(env, "GROK_PLUGIN_ROOT");
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
  return firstDefinedEnv("GROK_PLUGIN_ROOT");
}

/**
 * Companion jobs are scoped by CODEX_COMPANION_SESSION_ID when SessionStart can
 * export it. GROK_SESSION_ID is always injected into hook/agent processes and is
 * the reliable fallback when GROK_ENV_FILE is absent.
 */
export const COMPANION_SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return null;
}

/**
 * Resolve the Grok session id from a hook stdin envelope and/or process env.
 * Primary: sessionId (Grok camelCase), GROK_SESSION_ID.
 */
export function resolveHostSessionId(input = {}, env = process.env) {
  return firstNonEmpty(
    input?.sessionId,
    env.GROK_SESSION_ID,
    env[COMPANION_SESSION_ID_ENV],
    env.CODEX_COMPANION_SESSION_ID
  );
}

/**
 * Resolve the last assistant message for Stop/SubagentStop gates (Grok camelCase).
 */
export function resolveLastAssistantMessage(input = {}) {
  return firstNonEmpty(input?.lastAssistantMessage) || "";
}

/**
 * Resolve workspace cwd from a Grok hook envelope.
 */
export function resolveHookCwd(input = {}, env = process.env, fallbackCwd = process.cwd()) {
  return (
    firstNonEmpty(
      input?.cwd,
      input?.workspaceRoot,
      env.GROK_WORKSPACE_ROOT,
      env.GROK_PROJECT_DIR,
      env.PWD
    ) || fallbackCwd
  );
}

/**
 * Resolve hook event name from argv or Grok stdin (camelCase).
 */
export function resolveHookEventName(input = {}, argvEvent = "") {
  return firstNonEmpty(argvEvent, input?.hookEventName) || "";
}

/**
 * Resolve transcript path fields from Grok envelopes.
 */
export function resolveHookTranscriptPathField(input = {}) {
  return firstNonEmpty(input?.transcriptPath, input?.transcript, input?.transcript_path);
}

export function resolvePluginDataDir() {
  return firstDefinedEnv("GROK_PLUGIN_DATA");
}

export function resolveProjectDir(fallbackCwd) {
  return firstDefinedEnv("GROK_PROJECT_DIR", "GROK_WORKSPACE_ROOT", "PWD") || fallbackCwd || process.cwd();
}

export function resolveHostEnvFile() {
  return firstDefinedEnv("GROK_ENV_FILE");
}

export function resolveHostName() {
  return "Grok";
}

export function resolveUserHome() {
  return firstDefinedEnv("HOME", "USERPROFILE") || os.homedir();
}

export function resolveGrokHome() {
  return firstDefinedEnv("GROK_HOME") || path.join(resolveUserHome(), ".grok");
}

export function encodeGrokSessionGroup(cwd) {
  return encodeURIComponent(path.resolve(cwd));
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Export env vars into the host session env file when GROK_ENV_FILE is set.
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
 * Resolve plugin.json for the Grok plugin layout.
 */
export function resolvePluginManifestUrl(importMetaUrl) {
  const url = new URL("../../plugin.json", importMetaUrl);
  try {
    const filePath = fileURLToPath(url);
    if (fs.existsSync(filePath)) {
      return { url, path: filePath };
    }
  } catch {
    // Report the canonical URL with a null path when it cannot be resolved.
  }
  return { url, path: null };
}

/** @deprecated Use GROK_PLUGIN_ROOT_EXPR */
export const DUAL_HOST_PLUGIN_ROOT_EXPR = GROK_PLUGIN_ROOT_EXPR;
