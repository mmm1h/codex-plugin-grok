#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const ORIGIN_MARKER = /codex-plugin-grok/i;
const PLUGIN_PAYLOAD_ROOTS = new Set([
  ".lsp.json",
  ".mcp.json",
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "agents",
  "commands",
  "docs",
  "hooks",
  "plugin.json",
  "prompts",
  "schemas",
  "scripts",
  "skills"
]);
const TARGET_PRUNE_ROOTS = new Set([".claude-plugin", ".generated", ".grok-plugin"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/sync-installed-plugin.mjs [--apply] [--update-marketplace] [--deploy-user-plugin]",
    "",
    "Options:",
    "  --apply                 Write changes. The default is a dry run.",
    "  --update-marketplace    Also refresh a copied marketplace plugin tree.",
    "  --deploy-user-plugin    Deploy to <grok-home>/plugins/codex for Grok discovery.",
    "  --source <dir>          Source plugin directory (default: plugins/codex).",
    "  --grok-home <dir>       Grok home (default: GROK_HOME or ~/.grok).",
    "  --help                  Print this help."
  ].join("\n");
}

export function parseArgs(argv, env = process.env) {
  const options = {
    apply: false,
    deployUserPlugin: false,
    updateMarketplace: false,
    source: path.join(DEFAULT_ROOT, "plugins", "codex"),
    grokHome: env.GROK_HOME || path.join(os.homedir(), ".grok")
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--deploy-user-plugin") {
      options.deployUserPlugin = true;
    } else if (arg === "--update-marketplace") {
      options.updateMarketplace = true;
    } else if (arg === "--source" || arg === "--grok-home") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a directory.`);
      }
      options[arg === "--source" ? "source" : "grokHome"] = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.source = path.resolve(options.source);
  options.grokHome = path.resolve(options.grokHome);
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readPluginName(pluginDir) {
  for (const relativePath of ["plugin.json", path.join(".grok-plugin", "plugin.json")]) {
    const manifestPath = path.join(pluginDir, relativePath);
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    try {
      return readJson(manifestPath)?.name ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function pathsEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  try {
    return normalizeForComparison(fs.realpathSync(left)) === normalizeForComparison(fs.realpathSync(right));
  } catch {
    return normalizeForComparison(left) === normalizeForComparison(right);
  }
}

function isInside(parentDir, candidatePath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function recordMatchesSource(key, record, sourceDir, repoRoot) {
  const values = [
    key,
    record?.path,
    record?.kind?.source_path,
    record?.marketplace?.source_url_or_path,
    record?.marketplace?.source_display_name
  ].filter((value) => typeof value === "string" && value.trim());

  if (values.some((value) => ORIGIN_MARKER.test(value))) {
    return true;
  }

  return values.some((value) => pathsEqual(value, sourceDir) || pathsEqual(value, repoRoot));
}

function validateInstalledTarget(installedRoot, targetPath) {
  const resolved = path.resolve(targetPath);
  return isInside(installedRoot, resolved) && fs.existsSync(resolved) && readPluginName(resolved) === "codex";
}

export function discoverInstalledTargets({ grokHome, sourceDir }) {
  const installedRoot = path.join(grokHome, "installed-plugins");
  const registryPath = path.join(installedRoot, "registry.json");
  const repoRoot = path.resolve(sourceDir, "..", "..");
  const targets = [];
  const records = [];

  if (fs.existsSync(registryPath)) {
    const registry = readJson(registryPath);
    for (const [key, record] of Object.entries(registry?.repos ?? {})) {
      if (!record?.plugins?.codex || !recordMatchesSource(key, record, sourceDir, repoRoot)) {
        continue;
      }
      const targetPath = path.resolve(record.path || path.join(installedRoot, key));
      if (!validateInstalledTarget(installedRoot, targetPath)) {
        continue;
      }
      targets.push(targetPath);
      records.push(record);
    }
    return { targets: [...new Set(targets)], records, registryPath };
  }

  if (!fs.existsSync(installedRoot)) {
    return { targets: [], records: [], registryPath: null };
  }

  for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ORIGIN_MARKER.test(entry.name)) {
      continue;
    }
    const targetPath = path.join(installedRoot, entry.name);
    if (validateInstalledTarget(installedRoot, targetPath)) {
      targets.push(targetPath);
    }
  }
  return { targets, records: [], registryPath: null };
}

function inventoryTree(root, allowedRoots = null) {
  const entries = new Map();

  function visit(relativeDir) {
    const absoluteDir = path.join(root, relativeDir);
    for (const dirent of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!relativeDir && allowedRoots && !allowedRoots.has(dirent.name)) {
        continue;
      }
      const relativePath = path.join(relativeDir, dirent.name);
      const absolutePath = path.join(root, relativePath);
      if (dirent.isDirectory()) {
        entries.set(relativePath, { type: "directory" });
        visit(relativePath);
      } else if (dirent.isSymbolicLink()) {
        entries.set(relativePath, { type: "symlink", link: fs.readlinkSync(absolutePath) });
      } else if (dirent.isFile()) {
        entries.set(relativePath, { type: "file", data: fs.readFileSync(absolutePath) });
      }
    }
  }

  visit("");
  return entries;
}

function entriesEqual(left, right) {
  if (!left || !right || left.type !== right.type) {
    return false;
  }
  if (left.type === "file") {
    return left.data.equals(right.data);
  }
  if (left.type === "symlink") {
    return left.link === right.link;
  }
  return true;
}

export function planSync(sourceDir, targetDir, { allowMissingTarget = false } = {}) {
  if (readPluginName(sourceDir) !== "codex") {
    throw new Error(`Source is not a codex plugin directory: ${sourceDir}`);
  }
  const targetExists = fs.existsSync(targetDir);
  if (!targetExists && !allowMissingTarget) {
    throw new Error(`Target plugin directory does not exist: ${targetDir}`);
  }
  if (targetExists && readPluginName(targetDir) !== "codex") {
    throw new Error(`Target is not a codex plugin directory: ${targetDir}`);
  }

  const source = inventoryTree(sourceDir, PLUGIN_PAYLOAD_ROOTS);
  const target = targetExists ? inventoryTree(targetDir) : new Map();
  const managedRoots = new Set(
    [...source.keys()].map((relativePath) => relativePath.split(path.sep, 1)[0]).filter(Boolean)
  );
  for (const root of TARGET_PRUNE_ROOTS) {
    managedRoots.add(root);
  }
  const changes = [];

  for (const [relativePath, sourceEntry] of source) {
    const targetEntry = target.get(relativePath);
    if (!targetEntry) {
      changes.push({ action: "add", relativePath, sourceEntry });
    } else if (!entriesEqual(sourceEntry, targetEntry)) {
      changes.push({ action: "modify", relativePath, sourceEntry, targetEntry });
    } else {
      changes.push({ action: "unchanged", relativePath, sourceEntry, targetEntry });
    }
  }

  const removalRoots = changes
    .filter(
      (change) =>
        change.action === "modify" &&
        change.targetEntry?.type === "directory" &&
        change.sourceEntry?.type !== "directory"
    )
    .map((change) => change.relativePath);

  for (const [relativePath, targetEntry] of target) {
    const topLevel = relativePath.split(path.sep, 1)[0];
    if (managedRoots.has(topLevel) && !source.has(relativePath)) {
      if (removalRoots.some((root) => relativePath.startsWith(`${root}${path.sep}`))) {
        continue;
      }
      changes.push({ action: "remove", relativePath, targetEntry });
      if (targetEntry.type === "directory") {
        removalRoots.push(relativePath);
      }
    }
  }

  return changes;
}

function removePath(targetDir, relativePath) {
  const absolutePath = path.join(targetDir, relativePath);
  if (!isInside(targetDir, absolutePath)) {
    throw new Error(`Refusing to remove path outside sync target: ${absolutePath}`);
  }
  fs.rmSync(absolutePath, { recursive: true, force: true });
}

export function applySync(sourceDir, targetDir, changes) {
  const removals = changes
    .filter(
      (change) =>
        change.action === "remove" ||
        (change.action === "modify" && change.targetEntry?.type !== change.sourceEntry?.type)
    )
    .sort((left, right) => right.relativePath.length - left.relativePath.length);
  for (const change of removals) {
    removePath(targetDir, change.relativePath);
  }

  const writes = changes
    .filter((change) => change.action === "add" || change.action === "modify")
    .sort((left, right) => left.relativePath.length - right.relativePath.length);
  for (const change of writes) {
    const sourcePath = path.join(sourceDir, change.relativePath);
    const targetPath = path.join(targetDir, change.relativePath);
    if (change.sourceEntry.type === "directory") {
      fs.mkdirSync(targetPath, { recursive: true });
    } else if (change.sourceEntry.type === "symlink") {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.symlinkSync(change.sourceEntry.link, targetPath);
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function summarize(changes) {
  const counts = { add: 0, modify: 0, remove: 0, unchanged: 0 };
  for (const change of changes) {
    counts[change.action] += 1;
  }
  return `+${counts.add} ~${counts.modify} -${counts.remove} =${counts.unchanged}`;
}

function resolveMarketplaceCopies(records, sourceDir, installedTargets) {
  const copies = [];
  const linked = [];
  const seen = new Set();

  for (const record of records) {
    const subdir = record?.marketplace?.plugin_subdir || "plugins/codex";
    const rawCandidates = [record?.kind?.source_path, record?.marketplace?.source_url_or_path];
    for (const rawCandidate of rawCandidates) {
      if (typeof rawCandidate !== "string" || !path.isAbsolute(rawCandidate) || !fs.existsSync(rawCandidate)) {
        continue;
      }
      const candidate =
        readPluginName(rawCandidate) === "codex" ? rawCandidate : path.resolve(rawCandidate, subdir);
      if (!fs.existsSync(candidate) || readPluginName(candidate) !== "codex") {
        continue;
      }
      const key = normalizeForComparison(candidate);
      if (seen.has(key) || installedTargets.some((target) => pathsEqual(target, candidate))) {
        continue;
      }
      seen.add(key);
      if (pathsEqual(candidate, sourceDir)) {
        linked.push(candidate);
      } else {
        copies.push(candidate);
      }
    }
  }

  return { copies, linked };
}

function printSync(sourceDir, targetDir, changes, apply, label, targetStatus = null) {
  console.log(`${label}:`);
  console.log(`  from ${sourceDir}`);
  console.log(`  to   ${targetDir}`);
  if (targetStatus) {
    console.log(`  target ${targetStatus}`);
  }
  console.log(`  ${summarize(changes)}`);
  for (const change of changes.filter((entry) => entry.action !== "unchanged").slice(0, 30)) {
    console.log(`  ${change.action.padEnd(6)} ${change.relativePath}`);
  }
  const changedCount = changes.filter((entry) => entry.action !== "unchanged").length;
  if (changedCount > 30) {
    console.log(`  ... ${changedCount - 30} more change(s)`);
  }
  if (apply) {
    applySync(sourceDir, targetDir, changes);
  }
}

export function runSync(options) {
  const sourceDir = path.resolve(options.source);
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source plugin directory does not exist: ${sourceDir}`);
  }

  const discovery = discoverInstalledTargets({ grokHome: options.grokHome, sourceDir });
  if (discovery.targets.length === 0 && !options.deployUserPlugin) {
    const evidence = discovery.registryPath ? ` using ${discovery.registryPath}` : "";
    throw new Error(`No installed codex-plugin-grok snapshot found${evidence}.`);
  }

  console.log(options.apply ? "Mode: apply" : "Mode: dry-run (pass --apply to write)");
  if (discovery.targets.length === 0) {
    console.log("No installed codex-plugin-grok snapshot found; continuing with user plugin deployment.");
  }
  for (const targetDir of discovery.targets) {
    const changes = planSync(sourceDir, targetDir);
    printSync(sourceDir, targetDir, changes, options.apply, "Installed snapshot");
  }

  if (options.updateMarketplace) {
    const marketplace = resolveMarketplaceCopies(discovery.records, sourceDir, discovery.targets);
    for (const linkedPath of marketplace.linked) {
      console.log(`Marketplace already points at source: ${linkedPath}`);
    }
    for (const targetDir of marketplace.copies) {
      const changes = planSync(sourceDir, targetDir);
      printSync(sourceDir, targetDir, changes, options.apply, "Marketplace copy");
    }
    if (marketplace.linked.length === 0 && marketplace.copies.length === 0) {
      console.log("No local marketplace copy found; installed snapshot sync is still complete.");
    }
  }

  if (options.deployUserPlugin) {
    const targetDir = path.join(options.grokHome, "plugins", "codex");
    const targetExists = fs.existsSync(targetDir);
    const changes = planSync(sourceDir, targetDir, { allowMissingTarget: true });
    const targetStatus = targetExists
      ? "exists; managed plugin files will be overwritten"
      : "does not exist; it will be created";
    printSync(sourceDir, targetDir, changes, options.apply, "User plugin deployment", targetStatus);
    if (options.apply) {
      console.log(
        `User plugin deployed to ${targetDir} (${targetExists ? "existing directory updated" : "new directory created"}).`
      );
    } else {
      console.log(`User plugin would be deployed to ${targetDir}; dry run made no changes.`);
    }
  }

  console.log(options.apply ? "Files synchronized. Reload Grok plugins (r) or start a new session." : "Dry run only; no files changed.");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  runSync(options);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
