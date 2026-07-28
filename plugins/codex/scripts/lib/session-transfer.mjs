import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";
import { resolveGrokHome } from "./host-env.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";

/** Max characters retained per tool result body in converted transcripts. */
const TOOL_RESULT_MAX_CHARS = 4000;

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
  return encodeURIComponent(path.resolve(cwd));
}

function truncateText(text, max = TOOL_RESULT_MAX_CHARS) {
  const value = String(text ?? "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
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
          if (part.type === "tool_use" || part.type === "tool_call" || part.name) {
            const name = part.name || part.tool_name || "tool";
            const input = part.input ?? part.arguments ?? part.args;
            const argsText =
              typeof input === "string" ? input : input != null ? JSON.stringify(input) : "";
            return `[tool_call ${name}] ${truncateText(argsText, 500)}`.trim();
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text.trim();
    }
    try {
      return truncateText(JSON.stringify(content));
    } catch {
      return String(content).trim();
    }
  }
  return String(content).trim();
}

function formatToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  return toolCalls
    .map((call) => {
      if (!call || typeof call !== "object") {
        return "";
      }
      const name = call.name || call.tool_name || call.function?.name || "tool";
      const id = call.id || call.tool_call_id || "";
      const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments;
      const argsText =
        typeof rawArgs === "string" ? rawArgs : rawArgs != null ? JSON.stringify(rawArgs) : "";
      const idPart = id ? ` id=${id}` : "";
      return `[tool_call${idPart} ${name}] ${truncateText(argsText, 800)}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

function formatToolResult(entry) {
  const id = entry.tool_call_id || entry.toolCallId || entry.id || "";
  const name = entry.tool_name || entry.name || "";
  const body = extractTextContent(entry.content ?? entry.result ?? entry.output ?? entry.message?.content);
  const header = ["[tool_result", name ? ` ${name}` : "", id ? ` id=${id}` : "", "]"].join("");
  if (!body) {
    return header;
  }
  return `${header}\n${truncateText(body)}`;
}

function pushTurn(out, type, cwd, text) {
  const content = String(text ?? "").trim();
  if (!content) {
    return;
  }
  out.push({
    type,
    cwd,
    message: { role: type === "assistant" ? "assistant" : "user", content }
  });
}

/**
 * Convert a Grok session chat_history.jsonl into JSONL that Codex
 * externalAgentConfig/import can consume (Codex import turn shape).
 */
export function convertGrokChatHistoryToImportJsonl(sourcePath, options = {}) {
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
      pushTurn(out, "user", cwd, text);
      continue;
    }

    if (type === "assistant" || type === "model") {
      const text = extractTextContent(entry.content ?? entry.message?.content ?? entry.text);
      const tools = formatToolCalls(entry.tool_calls || entry.toolCalls || entry.message?.tool_calls);
      const combined = [text, tools].filter(Boolean).join("\n\n");
      pushTurn(out, "assistant", cwd, combined);
      continue;
    }

    if (type === "tool_result" || type === "tool" || type === "function_result") {
      pushTurn(out, "user", cwd, formatToolResult(entry));
      continue;
    }

    if (type === "tool_use" || type === "function_call") {
      pushTurn(out, "assistant", cwd, formatToolCalls([entry]));
    }
  }

  if (out.length <= 1) {
    throw new Error(`Grok session has no transferable user/assistant turns: ${sourcePath}`);
  }

  return `${out.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/**
 * Codex externalAgentConfig/import only records sessions under the historical
 * Claude Code projects tree (~/.claude/projects). That is a Codex CLI path
 * convention — Claude Code does NOT need to be installed.
 *
 * Grok chat_history is converted to the JSONL shape Codex expects and staged
 * under ~/.claude/projects/-grok-codex-transfer/ (created on demand).
 * Pure Grok machines work; this is not dual-host support.
 */
function resolveCodexImportStagingDir() {
  const home = firstDefinedHome();
  return path.join(home, ".claude", "projects", "-grok-codex-transfer");
}

function firstDefinedHome() {
  for (const name of ["HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value != null && String(value).trim() !== "") {
      return String(value);
    }
  }
  return os.homedir();
}

function materializeGrokImportSource(sourcePath, cwd) {
  const sessionDir = path.dirname(sourcePath);
  const sessionId = path.basename(sessionDir);
  let title = sessionId;
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(sessionDir, "summary.json"), "utf8"));
    title = summary.generated_title || summary.session_summary || sessionId;
  } catch {
    // optional
  }

  const converted = convertGrokChatHistoryToImportJsonl(sourcePath, { cwd, title });
  // Stage under Codex's expected import tree (auto-create; no Claude app required).
  const importDir = resolveCodexImportStagingDir();
  fs.mkdirSync(importDir, { recursive: true });
  const safeId = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "session";
  const outPath = path.join(importDir, `grok-transfer-${safeId}.jsonl`);
  fs.writeFileSync(outPath, converted, "utf8");
  return outPath;
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
 * Resolve a Grok session transcript for transfer into Codex.
 * Returns { sourcePath, host, importPath } where importPath is the converted JSONL.
 */
export function resolveSessionTransferSource(cwd, options = {}) {
  const requestedPath =
    options.source ||
    process.env[TRANSCRIPT_PATH_ENV] ||
    autoResolveGrokTranscript(
      cwd,
      options.sessionId || process.env.CODEX_COMPANION_SESSION_ID || process.env.GROK_SESSION_ID
    );

  if (!requestedPath) {
    throw new Error(
      "Could not identify the current Grok transcript. Retry with --source <path-to-chat_history.jsonl>."
    );
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Session file not found: ${sourcePath}`);
  }

  const realSource = fs.realpathSync(sourcePath);
  const grokSessions = path.join(resolveGrokHome(), "sessions");

  if (!fs.existsSync(grokSessions)) {
    throw new Error(`Grok sessions directory not found: ${grokSessions}`);
  }

  const sessionsReal = fs.realpathSync(grokSessions);
  if (!isInsideDir(sessionsReal, realSource)) {
    throw new Error(`Session source must live under ${grokSessions}: ${realSource}`);
  }

  const resolved = resolveGrokSessionPathStrict(realSource);
  const importPath = materializeGrokImportSource(resolved, cwd);
  return {
    host: "grok",
    sourcePath: resolved,
    importPath,
    converted: true
  };
}

