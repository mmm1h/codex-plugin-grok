import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses ask_user_question and background shell while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /ask_user_question/);
  assert.match(source, /run_terminal_command/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /background:\s*true/);
  assert.match(source, /GROK_PLUGIN_ROOT/);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses ask_user_question and background shell while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /ask_user_question/);
  assert.match(source, /run_terminal_command/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /background:\s*true/);
  assert.match(source, /GROK_PLUGIN_ROOT/);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics for Grok", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /spawn_subagent/);
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /ask_user_question/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(agent, /run_terminal_command/);
  assert.match(agent, /GROK_PLUGIN_ROOT/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /GROK_PLUGIN_ROOT/);
  assert.match(runtimeSkill, /host-side work allowed/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, Codex chooses its own defaults/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark` maps to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(transfer, /Grok sessions/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Grok-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
  assert.match(source, /\$\{GROK_PLUGIN_ROOT\}/);
  assert.doesNotMatch(source, /CLAUDE_PLUGIN_ROOT/);
});

test("shipped docs avoid machine-local absolute user paths", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const agent = read("agents/codex-rescue.md");
  assert.doesNotMatch(readme, /C:\/Users\/PC/i);
  assert.doesNotMatch(agent, /C:\/Users\/PC/i);
  assert.match(readme, /\/path\/to\/codex-plugin-grok|path\/to\/codex-plugin-grok/);
  assert.match(readme, /grok plugin update codex/);
  assert.match(readme, /deduplicates same-name plugins/i);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /ask_user_question/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

test("marketplace Grok manifest exists (no Claude dual-host)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".grok-plugin", "marketplace.json")), true);
  assert.equal(fs.existsSync(path.join(ROOT, ".claude-plugin", "marketplace.json")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, ".grok-plugin", "plugin.json")), true);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")), false);
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".grok-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].name, "codex");
  assert.match(marketplace.metadata.version, /grok/i);
});

test("slash commands are exposed as Grok-native skills", () => {
  for (const name of ["setup", "review", "status", "transfer", "rescue", "cancel", "result", "adversarial-review"]) {
    const skill = path.join(PLUGIN_ROOT, "skills", name, "SKILL.md");
    assert.equal(fs.existsSync(skill), true, `missing skill ${name}`);
    const source = fs.readFileSync(skill, "utf8");
    assert.match(source, new RegExp(`name:\\s*${name}`));
    assert.match(source, /user-invocable:\s*true/);
    assert.match(source, /GROK_PLUGIN_ROOT/);
  }
});

test("Windows invoke-codex helper ships and avoids bash stdin redirection", () => {
  const helper = path.join(PLUGIN_ROOT, "scripts", "invoke-codex.ps1");
  assert.equal(fs.existsSync(helper), true);
  const source = fs.readFileSync(helper, "utf8");
  assert.match(source, /Get-Content\s+-Raw/);
  assert.match(source, /tmp\/codex-out|tmp\\codex-out|Join-Path.*tmp/);
  assert.doesNotMatch(source, /codex exec[^\n]*<\s/);
  assert.match(source, /PromptFile/);
  assert.doesNotMatch(source, /\[string\]\$Profile\s*=\s*["']codex-api["']/i);
  assert.match(source, /if \(\$Profile\)/);
  assert.ok(
    source.indexOf('npm\\codex.cmd') < source.indexOf('Get-Command codex -ErrorAction'),
    "codex.cmd should be preferred over codex.ps1"
  );
});

test("Windows invoke-codex helper omits --profile unless explicitly requested", { skip: process.platform !== "win32" }, () => {
  const repo = makeTempDir("codex-pwsh-helper-");
  const helper = path.join(PLUGIN_ROOT, "scripts", "invoke-codex.ps1");
  const fakeCodex = path.join(repo, "fake-codex.cmd");
  const argsFile = path.join(repo, "args.txt");
  fs.writeFileSync(
    fakeCodex,
    [
      "@echo off",
      "setlocal EnableDelayedExpansion",
      "set \"outFile=\"",
      ":loop",
      "if \"%~1\"==\"\" goto done",
      ">>\"%CODEX_TEST_ARGS%\" echo %~1",
      "if \"%~1\"==\"-o\" set \"outFile=%~2\"",
      "shift",
      "goto loop",
      ":done",
      "if defined outFile >\"!outFile!\" echo fake result",
      "exit /b 0",
      ""
    ].join("\r\n"),
    "utf8"
  );

  const invoke = (extra = []) =>
    spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        helper,
        "-Repo",
        repo,
        "-Prompt",
        "status only",
        "-CodexCmd",
        fakeCodex,
        ...extra
      ],
      {
        cwd: repo,
        env: { ...process.env, CODEX_TEST_ARGS: argsFile },
        encoding: "utf8",
        windowsHide: true
      }
    );

  const withoutProfile = invoke(["-OutName", "default.md"]);
  assert.equal(withoutProfile.status, 0, withoutProfile.stderr);
  let captured = fs.readFileSync(argsFile, "utf8");
  assert.doesNotMatch(captured, /^--profile$/m);
  assert.equal(fs.existsSync(path.join(repo, "tmp", "codex-out", "default.md")), true);

  fs.writeFileSync(argsFile, "", "utf8");
  const withProfile = invoke(["-Profile", "codex-api", "-OutName", "profile.md"]);
  assert.equal(withProfile.status, 0, withProfile.stderr);
  captured = fs.readFileSync(argsFile, "utf8");
  assert.match(captured, /^--profile\r?\ncodex-api$/m);
});

test("build preflight uses a cross-platform Node generator", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const generator = fs.readFileSync(path.join(ROOT, "scripts", "generate-app-server-types.mjs"), "utf8");
  assert.equal(packageJson.scripts.prebuild, "node scripts/generate-app-server-types.mjs");
  assert.doesNotMatch(packageJson.scripts.prebuild, /mkdir\s+-p/);
  assert.match(generator, /mkdirSync/);
  assert.match(generator, /resolveCommandInvocation\("codex", codexArgs\)/);
  assert.match(generator, /spawnSync\(invocation\.command, invocation\.args/);
  assert.match(generator, /shell:\s*false/);
  assert.doesNotMatch(generator, /process\.env\.ComSpec/);
  assert.doesNotMatch(generator, /shell:\s*true/);
});
