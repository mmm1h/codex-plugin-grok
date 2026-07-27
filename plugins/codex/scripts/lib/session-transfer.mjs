import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";
import { resolveGrokHome, resolveClaudeHome } from "./host-env.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function isInsideDir(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return !(relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function encodeGrokSessionGroup(cwd) {
  // Grok stores sessions under URL-encoded cwd names (Windows backslashes included).
  return encodeURIComponent(path.resolve(cwd));
}

function extractTextContent(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.content === "string") {
            return part.content;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }
  return String(content).trim();
}

/**
 * Convert a Grok session chat_history.jsonl into Claude-style JSONL that
 * Codex externalAgentConfig/import can consume.
 */
export function convertGrokChatHistoryToClaudeJsonl(sourcePath, options = {}) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const cwd = options.cwd || process.cwd();
  const title = options.title || path.basename(path.dirname(sourcePath));
  const out = [];

  if (title) {
    out.push({ type: "custom-title", customTitle: title });
  }

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const type = String(entry.type || entry.role || "").toLowerCase();
    if (type === "system" || type === "reasoning") {
      continue;
    }

    if (type === "user") {
      const text = extractTextContent(entry.content ?? entry.message?.content ?? entry.text);
      if (!text) {
        continue;
      }
      out.push({
        type: "user",
        cwd,
        message: { role: "user", content: text }
      });
      continue;
    }

    if (type === "assistant" || type === "model") {
      const text = extractTextContent(entry.content ?? entry.message?.content ?? entry.text);
      if (!text) {
        continue;
      }
      out.push({
        type: "assistant",
        cwd,
        message: { role: "assistant", content: text }
      });
    }
  }

  if (out.length <= 1) {
    throw new Error(`Grok session has no transferable user/assistant turns: ${sourcePath}`);
  }

  return `${out.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function materializeGrokImportSource(sourcePath, cwd, cacheDir) {
  const sessionDir = path.dirname(sourcePath);
  const sessionId = path.basename(sessionDir);
  let title = sessionId;
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(sessionDir, "summary.json"), "utf8"));
    title = summary.generated_title || summary.session_summary || sessionId;
  } catch {
    // optional
  }

  const converted = convertGrokChatHistoryToClaudeJsonl(sourcePath, { cwd, title });
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `grok-transfer-${sessionId}.jsonl`);
  fs.writeFileSync(outPath, converted, "utf8");
  return outPath;
}

function resolveClaudeSessionPathStrict(sourcePath) {
  const projects = fs.realpathSync(path.join(resolveClaudeHome(), "projects"));
  const source = fs.realpathSync(sourcePath);
  if (!isInsideDir(projects, source)) {
    throw new Error(`Codex can import Claude sessions only from ${projects}: ${source}`);
  }
  if (path.extname(source) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${source}`);
  }
  return source;
}

function resolveGrokSessionPathStrict(sourcePath) {
  const sessionsRoot = fs.realpathSync(path.join(resolveGrokHome(), "sessions"));
  const source = fs.realpathSync(sourcePath);
  if (!isInsideDir(sessionsRoot, source)) {
    throw new Error(`Codex can import Grok sessions only from ${sessionsRoot}: ${source}`);
  }
  const base = path.basename(source);
  if (base !== "chat_history.jsonl" && path.extname(source) !== ".jsonl") {
    throw new Error(`Grok session source must be chat_history.jsonl (or a JSONL file): ${source}`);
  }
  return source;
}

function autoResolveGrokTranscript(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  const group = encodeGrokSessionGroup(cwd);
  const candidate = path.join(resolveGrokHome(), "sessions", group, sessionId, "chat_history.jsonl");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}

/**
 * Resolve a host session transcript for transfer into Codex.
 * Returns { sourcePath, host, importPath } where importPath is what Codex should import
 * (may be a converted temp Claude-format JSONL for Grok sessions).
 */
export function resolveSessionTransferSource(cwd, options = {}) {
  const requestedPath =
    options.source ||
    process.env[TRANSCRIPT_PATH_ENV] ||
    autoResolveGrokTranscript(cwd, options.sessionId || process.env.CODEX_COMPANION_SESSION_ID);

  if (!requestedPath) {
    throw new Error(
      "Could not identify the current host transcript. Retry with --source <path-to-session-jsonl>."
    );
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Session file not found: ${sourcePath}`);
  }

  const realSource = fs.realpathSync(sourcePath);
  const claudeProjects = path.join(resolveClaudeHome(), "projects");
  const grokSessions = path.join(resolveGrokHome(), "sessions");

  // Claude native path
  if (fs.existsSync(claudeProjects)) {
    try {
      const projectsReal = fs.realpathSync(claudeProjects);
      if (isInsideDir(projectsReal, realSource)) {
        const resolved = resolveClaudeSessionPathStrict(realSource);
        return {
          host: "claude",
          sourcePath: resolved,
          importPath: resolved,
          converted: false
        };
      }
    } catch {
      // fall through
    }
  }

  // Grok session path (chat_history.jsonl under ~/.grok/sessions)
  if (fs.existsSync(grokSessions)) {
    try {
      const sessionsReal = fs.realpathSync(grokSessions);
      if (isInsideDir(sessionsReal, realSource)) {
        const resolved = resolveGrokSessionPathStrict(realSource);
        const cacheDir = path.join(
          process.env.GROK_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || os.tmpdir(),
          "codex-companion",
          "transfer-cache"
        );
        const importPath = materializeGrokImportSource(resolved, cwd, cacheDir);
        return {
          host: "grok",
          sourcePath: resolved,
          importPath,
          converted: true
        };
      }
    } catch (error) {
      throw error;
    }
  }

  throw new Error(
    `Session source must live under ${claudeProjects} (Claude) or ${grokSessions} (Grok): ${realSource}`
  );
}

/** @deprecated Prefer resolveSessionTransferSource. Kept for callers/tests that only need Claude. */
export function resolveClaudeSessionPath(cwd, options = {}) {
  const result = resolveSessionTransferSource(cwd, options);
  if (result.host !== "claude") {
    // For pure Claude callers, return import path only when it is Claude-native.
    // Grok conversion still returns a usable path, so allow it.
  }
  return result.importPath;
}
