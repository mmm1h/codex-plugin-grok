#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOLEAN_KEYS = ["user-invocable", "disable-model-invocation"];

function addError(errors, file, field, message) {
  errors.push(`${file}: ${field} ${message}`);
}

function readJson(root, relativePath, errors) {
  const filePath = path.join(root, relativePath);
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    addError(errors, relativePath, "file", `cannot be read: ${error.message}`);
    return null;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    addError(errors, relativePath, "JSON", `is invalid: ${error.message}`);
    return null;
  }
}

function requireObject(errors, file, value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    addError(errors, file, field, "must be an object.");
    return false;
  }
  return true;
}

function requireString(errors, file, value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    addError(errors, file, field, "must be a non-empty string.");
    return false;
  }
  return true;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(source, relativePath, errors) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    addError(errors, relativePath, "frontmatter", "must start with ---.");
    return null;
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    addError(errors, relativePath, "frontmatter", "must have a closing --- delimiter.");
    return null;
  }

  const result = {};
  const lines = normalized.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      addError(errors, relativePath, `frontmatter line ${index + 2}`, "is not a supported key/value entry.");
      continue;
    }
    const [, key, rawValue = ""] = match;
    result[key] = parseScalar(rawValue);
  }
  return result;
}

function validateFrontmatterFile(root, relativePath, kind, errors) {
  let source;
  try {
    source = fs.readFileSync(path.join(root, relativePath), "utf8");
  } catch (error) {
    addError(errors, relativePath, "file", `cannot be read: ${error.message}`);
    return null;
  }
  const frontmatter = parseFrontmatter(source, relativePath, errors);
  if (!frontmatter) return null;
  requireString(errors, relativePath, frontmatter.description, "description");
  if (kind === "skill") requireString(errors, relativePath, frontmatter.name, "name");
  for (const key of BOOLEAN_KEYS) {
    if (key in frontmatter && typeof frontmatter[key] !== "boolean") {
      addError(errors, relativePath, key, "must be a boolean when present.");
    }
  }
  return frontmatter;
}

function validatePluginManifest(root, errors) {
  const file = "plugins/codex/plugin.json";
  const manifest = readJson(root, file, errors);
  if (!requireObject(errors, file, manifest, "root")) return;
  requireString(errors, file, manifest.name, "name");
  requireString(errors, file, manifest.version, "version");
  requireString(errors, file, manifest.description, "description");
  if (requireObject(errors, file, manifest.author, "author")) {
    requireString(errors, file, manifest.author.name, "author.name");
  }
}

function validateMarketplace(root, errors) {
  const file = ".grok-plugin/marketplace.json";
  const manifest = readJson(root, file, errors);
  if (!requireObject(errors, file, manifest, "root")) return;
  requireString(errors, file, manifest.name, "name");
  if (requireObject(errors, file, manifest.owner, "owner")) {
    requireString(errors, file, manifest.owner.name, "owner.name");
  }
  if (requireObject(errors, file, manifest.metadata, "metadata")) {
    requireString(errors, file, manifest.metadata.description, "metadata.description");
    requireString(errors, file, manifest.metadata.version, "metadata.version");
  }
  if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) {
    addError(errors, file, "plugins", "must be a non-empty array.");
    return;
  }
  for (let index = 0; index < manifest.plugins.length; index += 1) {
    const plugin = manifest.plugins[index];
    const field = `plugins[${index}]`;
    if (!requireObject(errors, file, plugin, field)) continue;
    requireString(errors, file, plugin.name, `${field}.name`);
    requireString(errors, file, plugin.description, `${field}.description`);
    requireString(errors, file, plugin.version, `${field}.version`);
    if (requireObject(errors, file, plugin.author, `${field}.author`)) {
      requireString(errors, file, plugin.author.name, `${field}.author.name`);
    }
    if (!requireString(errors, file, plugin.source, `${field}.source`)) continue;
    const sourcePath = path.resolve(root, plugin.source);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      addError(errors, file, `${field}.source`, `must point to an existing directory: ${plugin.source}`);
    }
  }
}

function validateEntrypoints(root, errors) {
  const commandsDir = path.join(root, "plugins", "codex", "commands");
  const skillsDir = path.join(root, "plugins", "codex", "skills");
  const commands = new Set();
  const publicSkills = new Set();

  for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    commands.add(name);
    validateFrontmatterFile(root, `plugins/codex/commands/${entry.name}`, "command", errors);
  }

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relativePath = `plugins/codex/skills/${entry.name}/SKILL.md`;
    if (!fs.existsSync(path.join(root, relativePath))) {
      addError(errors, relativePath, "file", "is required for every skill directory.");
      continue;
    }
    const frontmatter = validateFrontmatterFile(root, relativePath, "skill", errors);
    if (!frontmatter) continue;
    if (frontmatter.name !== entry.name) {
      addError(errors, relativePath, "name", `must match its directory name (${entry.name}).`);
    }
    if (frontmatter["user-invocable"] !== false) publicSkills.add(entry.name);
  }

  for (const name of commands) {
    if (!publicSkills.has(name)) addError(errors, `plugins/codex/commands/${name}.md`, "entrypoint", "has no matching public skill.");
  }
  for (const name of publicSkills) {
    if (!commands.has(name)) addError(errors, `plugins/codex/skills/${name}/SKILL.md`, "entrypoint", "has no matching command.");
  }
}

function validateHooks(root, errors) {
  const file = "plugins/codex/hooks/hooks.json";
  const manifest = readJson(root, file, errors);
  if (!requireObject(errors, file, manifest, "root")) return;
  if (!requireObject(errors, file, manifest.hooks, "hooks")) return;

  function visit(value, field) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${field}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.type === "command") {
      if (!requireString(errors, file, value.command, `${field}.command`)) return;
      const references = [...value.command.matchAll(/\$\{GROK_PLUGIN_ROOT\}\/([^\s"']+)/g)];
      if (references.length === 0) {
        addError(errors, file, `${field}.command`, "must reference a path under ${GROK_PLUGIN_ROOT}.");
      }
      for (const reference of references) {
        const scriptPath = path.join(root, "plugins", "codex", ...reference[1].split("/"));
        if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
          addError(errors, file, `${field}.command`, `references a missing script: ${reference[1]}`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${field}.${key}`);
  }

  visit(manifest.hooks, "hooks");
}

export function validatePlugin(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const errors = [];
  validatePluginManifest(resolvedRoot, errors);
  validateMarketplace(resolvedRoot, errors);
  try {
    validateEntrypoints(resolvedRoot, errors);
  } catch (error) {
    addError(errors, "plugins/codex", "entrypoints", `cannot be enumerated: ${error.message}`);
  }
  validateHooks(resolvedRoot, errors);
  return errors;
}

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root" || !argv[index + 1]) {
      throw new Error(`Usage: node scripts/validate-plugin.mjs [--root <repository>]`);
    }
    root = argv[index + 1];
    index += 1;
  }
  return root;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    const errors = validatePlugin(parseArgs(process.argv.slice(2)));
    if (errors.length > 0) {
      console.error(`Plugin validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):`);
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      console.log("Plugin validation passed.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
