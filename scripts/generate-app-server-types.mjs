#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCommandInvocation } from "../plugins/codex/scripts/lib/process.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "plugins", "codex", ".generated", "app-server-types");
fs.mkdirSync(outDir, { recursive: true });

const codexArgs = ["app-server", "generate-ts", "--out", outDir];
const invocation = resolveCommandInvocation("codex", codexArgs);
const result = spawnSync(invocation.command, invocation.args, {
  cwd: root,
  stdio: "inherit",
  shell: false,
  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  windowsHide: true
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
