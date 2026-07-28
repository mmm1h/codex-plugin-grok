import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "sync-installed-plugin.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makePlugin(pluginDir, marker) {
  writeJson(path.join(pluginDir, "plugin.json"), {
    name: "codex",
    version: "1.1.3-grok"
  });
  fs.mkdirSync(path.join(pluginDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills", "review"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "scripts", "runtime.mjs"), `export const marker = "${marker}";\n`);
  fs.writeFileSync(path.join(pluginDir, "skills", "review", "SKILL.md"), `# ${marker}\n`);
}

function makeRegistry(grokHome, installedDir, sourceDir, marketplaceRoot = path.resolve(sourceDir, "..", "..")) {
  writeJson(path.join(grokHome, "installed-plugins", "registry.json"), {
    version: 1,
    repos: {
      "codex-plugin-grok-test": {
        kind: {
          type: "Local",
          source_path: sourceDir
        },
        path: installedDir,
        plugins: {
          codex: {
            version: "1.1.2-grok"
          }
        },
        marketplace: {
          source_url_or_path: marketplaceRoot,
          source_display_name: "codex-plugin-grok",
          plugin_subdir: "plugins/codex"
        }
      }
    }
  });
}

test("sync-installed defaults to dry-run and apply mirrors managed trees while preserving local state", () => {
  const root = makeTempDir("codex-sync-");
  const sourceDir = path.join(root, "checkout", "plugins", "codex");
  const grokHome = path.join(root, "grok-home");
  const installedDir = path.join(grokHome, "installed-plugins", "codex-plugin-grok-snapshot");

  makePlugin(sourceDir, "source");
  fs.mkdirSync(path.join(sourceDir, ".generated"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, ".generated", "dev-only.ts"), "do not install\n");
  makePlugin(installedDir, "old");
  fs.writeFileSync(path.join(installedDir, "scripts", "removed.mjs"), "stale\n");
  fs.writeFileSync(path.join(installedDir, "local-state.json"), "keep me\n");
  fs.mkdirSync(path.join(installedDir, ".generated"), { recursive: true });
  fs.writeFileSync(path.join(installedDir, ".generated", "dev-cache.ts"), "remove me\n");
  writeJson(path.join(installedDir, ".claude-plugin", "plugin.json"), {
    name: "codex",
    version: "legacy"
  });
  writeJson(path.join(installedDir, ".grok-plugin", "plugin.json"), {
    name: "codex",
    version: "duplicate"
  });
  makeRegistry(grokHome, installedDir, sourceDir);

  const dryRun = run(process.execPath, [SCRIPT, "--source", sourceDir, "--grok-home", grokHome]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Mode: dry-run/);
  assert.match(dryRun.stdout, /Installed snapshot/);
  assert.match(dryRun.stdout, /removed\.mjs/);
  assert.match(fs.readFileSync(path.join(installedDir, "scripts", "runtime.mjs"), "utf8"), /old/);

  const applied = run(process.execPath, [
    SCRIPT,
    "--source",
    sourceDir,
    "--grok-home",
    grokHome,
    "--apply"
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Files synchronized/);
  assert.match(applied.stdout, /Reload Grok plugins/);
  assert.equal(
    fs.readFileSync(path.join(installedDir, "scripts", "runtime.mjs"), "utf8"),
    fs.readFileSync(path.join(sourceDir, "scripts", "runtime.mjs"), "utf8")
  );
  assert.equal(fs.existsSync(path.join(installedDir, "scripts", "removed.mjs")), false);
  assert.equal(fs.existsSync(path.join(installedDir, ".generated", "dev-only.ts")), false);
  assert.equal(fs.existsSync(path.join(installedDir, ".generated")), false);
  assert.equal(fs.existsSync(path.join(installedDir, ".claude-plugin")), false);
  assert.equal(fs.existsSync(path.join(installedDir, ".grok-plugin")), false);
  assert.equal(fs.readFileSync(path.join(installedDir, "local-state.json"), "utf8"), "keep me\n");
});

test("sync-installed can update a copied marketplace plugin tree", () => {
  const root = makeTempDir("codex-sync-marketplace-");
  const sourceDir = path.join(root, "checkout", "plugins", "codex");
  const marketplaceRoot = path.join(root, "codex-plugin-grok-cache");
  const marketplacePlugin = path.join(marketplaceRoot, "plugins", "codex");
  const grokHome = path.join(root, "grok-home");
  const installedDir = path.join(grokHome, "installed-plugins", "codex-plugin-grok-snapshot");

  makePlugin(sourceDir, "source");
  makePlugin(marketplacePlugin, "marketplace-old");
  makePlugin(installedDir, "installed-old");
  makeRegistry(grokHome, installedDir, marketplacePlugin, marketplaceRoot);

  const applied = run(process.execPath, [
    SCRIPT,
    "--source",
    sourceDir,
    "--grok-home",
    grokHome,
    "--update-marketplace",
    "--apply"
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Marketplace copy/);
  assert.match(fs.readFileSync(path.join(marketplacePlugin, "scripts", "runtime.mjs"), "utf8"), /source/);
  assert.match(fs.readFileSync(path.join(installedDir, "scripts", "runtime.mjs"), "utf8"), /source/);
});

test("sync-installed refuses unrelated codex snapshots", () => {
  const root = makeTempDir("codex-sync-unrelated-");
  const sourceDir = path.join(root, "checkout", "plugins", "codex");
  const grokHome = path.join(root, "grok-home");
  const installedDir = path.join(grokHome, "installed-plugins", "official-codex");
  makePlugin(sourceDir, "source");
  makePlugin(installedDir, "official");
  writeJson(path.join(grokHome, "installed-plugins", "registry.json"), {
    version: 1,
    repos: {
      official: {
        kind: { type: "Git", source_path: "cache/openai/codex" },
        path: installedDir,
        plugins: { codex: { version: "1.0.0" } },
        marketplace: { source_url_or_path: "https://github.com/openai/codex-plugin-cc" }
      }
    }
  });

  const result = run(process.execPath, [SCRIPT, "--source", sourceDir, "--grok-home", grokHome]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No installed codex-plugin-grok snapshot found/);
});
