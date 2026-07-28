import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATOR = path.join(ROOT, "scripts", "validate-plugin.mjs");

function makeFixture() {
  const root = makeTempDir("codex-plugin-validation-");
  fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
  fs.cpSync(path.join(ROOT, "plugins", "codex"), path.join(root, "plugins", "codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".grok-plugin"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, ".grok-plugin", "marketplace.json"),
    path.join(root, ".grok-plugin", "marketplace.json")
  );
  return root;
}

function validate(root) {
  return run(process.execPath, [VALIDATOR, "--root", root]);
}

test("validate-plugin accepts the shipped manifests and entrypoints", () => {
  const result = validate(makeFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin validation passed\./);
});

test("validate-plugin rejects a missing required manifest field", () => {
  const root = makeFixture();
  const file = path.join(root, "plugins", "codex", "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  delete manifest.description;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = validate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugins\/codex\/plugin\.json: description must be a non-empty string/);
});

test("validate-plugin rejects a skill name that differs from its directory", () => {
  const root = makeFixture();
  const file = path.join(root, "plugins", "codex", "skills", "review", "SKILL.md");
  const source = fs.readFileSync(file, "utf8").replace(/^name: review$/m, "name: renamed-review");
  fs.writeFileSync(file, source);

  const result = validate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /name must match its directory name \(review\)/);
});

test("validate-plugin rejects hooks that reference a missing script", () => {
  const root = makeFixture();
  const file = path.join(root, "plugins", "codex", "hooks", "hooks.json");
  const hooks = JSON.parse(fs.readFileSync(file, "utf8"));
  hooks.hooks.SessionStart[0].hooks[0].command = 'node "${GROK_PLUGIN_ROOT}/scripts/missing-hook.mjs"';
  fs.writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`);

  const result = validate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /references a missing script: scripts\/missing-hook\.mjs/);
});
