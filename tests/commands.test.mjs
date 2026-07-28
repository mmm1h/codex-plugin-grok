import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { STOP_REVIEW_TASK_MARKER } from "../plugins/codex/scripts/lib/prompts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SLASH_COMMANDS = [
  "setup",
  "review",
  "status",
  "transfer",
  "rescue",
  "cancel",
  "result",
  "adversarial-review"
];

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function markdownBody(source) {
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, "expected Markdown frontmatter");
  return match[1];
}

function markdownFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return markdownFilesUnder(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
  });
}

test("review command uses ask_user_question and background shell while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /ask_user_question/);
  assert.match(source, /run_terminal_command/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /args-path review/);
  assert.match(source, /review --args-file/);
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
  assert.match(source, /args-path adversarial-review/);
  assert.match(source, /adversarial-review --args-file/);
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

test("slash templates use fail-closed args-file transport and mirror command bodies", () => {
  for (const name of SLASH_COMMANDS) {
    const command = read(`commands/${name}.md`);
    const skill = read(`skills/${name}/SKILL.md`);

    for (const [kind, source] of [["command", command], ["skill", skill]]) {
      assert.match(source, /allowed-tools:[^\r\n]*search_replace/, `${kind} ${name}`);
      assert.match(source, /Safe argument transport:/, `${kind} ${name}`);
      assert.match(source, /args-path/, `${kind} ${name}`);
      assert.match(source, /--args-file/, `${kind} ${name}`);
      assert.match(source, /search_replace/, `${kind} ${name}`);
      assert.match(source, /old_string[^\r\n]*empty string/i, `${kind} ${name}`);
      assert.match(source, /new_string[^\r\n]*(?:exact raw|complete final)/i, `${kind} ${name}`);
      assert.match(source, /empty or whitespace-only/i, `${kind} ${name}`);
      assert.match(source, /fresh path/i, `${kind} ${name}`);
      assert.match(source, /fail closed/i, `${kind} ${name}`);
      assert.doesNotMatch(source, /"\$ARGUMENTS"/, `${kind} ${name}`);

      const shellInterpolation = source
        .split(/\r?\n/)
        .filter((line) => line.includes("codex-companion.mjs") && line.includes("$ARGUMENTS"));
      assert.deepEqual(shellInterpolation, [], `${kind} ${name} interpolates raw arguments`);
    }

    assert.equal(
      markdownBody(skill),
      markdownBody(command),
      `${name} command and skill bodies must remain mirrored`
    );
  }

  for (const name of ["cancel", "result", "status", "transfer"]) {
    for (const source of [read(`commands/${name}.md`), read(`skills/${name}/SKILL.md`)]) {
      assert.match(source, /disable-model-invocation:\s*true/);
      assert.doesNotMatch(source, /!`/);
    }
  }

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /raw slash text is never interpolated into a shell command/i);
  assert.match(readme, /Direct CLI usage keeps the positional argument form unchanged/i);
});

test("all Markdown treats ARGUMENTS as a standalone data placeholder", () => {
  const references = markdownFilesUnder(PLUGIN_ROOT).flatMap((file) =>
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("$ARGUMENTS"))
      .map((line) => ({ file, line: line.trim() }))
  );

  assert.equal(references.length, SLASH_COMMANDS.length * 2);
  for (const reference of references) {
    assert.match(reference.line, /^`?\$ARGUMENTS`?$/, reference.file);
  }
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
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
  assert.match(rescue, /actual availability depends on the selected model/i);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /ask_user_question/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(agent, /run_terminal_command/);
  assert.match(agent, /tools: run_terminal_command, search_replace/);
  assert.match(agent, /args-path task/);
  assert.match(agent, /task --args-file/);
  assert.match(agent, /old_string[^\r\n]*empty string/i);
  assert.match(agent, /fail closed/i);
  assert.match(agent, /GROK_PLUGIN_ROOT/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /GROK_PLUGIN_ROOT/);
  assert.match(runtimeSkill, /old_string[^\r\n]*empty/i);
  assert.match(runtimeSkill, /host-side work allowed/i);
  assert.match(runtimeSkill, /accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`/i);
  assert.match(runtimeSkill, /actual availability depends on the selected model/i);
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

test("transfer, result, and cancel commands preserve their runtime contracts", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /args-path transfer/);
  assert.match(transfer, /transfer --args-file/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(transfer, /Grok sessions/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /args-path result/);
  assert.match(result, /result --args-file/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /args-path cancel/);
  assert.match(cancel, /cancel --args-file/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Grok-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /args-path task/);
  assert.match(runtimeSkill, /task --args-file/);
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
  assert.match(readme, /not in Grok's plugin discovery priority list/i);
  assert.match(readme, /~\/\.grok\/plugins\/codex/);
  assert.match(readme, /claude plugin disable[^.\n]*no effect on Grok discovery/i);
  assert.match(readme, /11 skills[^.\n]*official plugin's 3/i);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /ask_user_question/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /args-path setup/);
  assert.match(setup, /setup --json --args-file/);
  assert.match(readme, /codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

test("Grok uses one root plugin manifest (no Claude dual-host)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, ".grok-plugin", "marketplace.json")), true);
  assert.equal(fs.existsSync(path.join(ROOT, ".claude-plugin", "marketplace.json")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, "plugin.json")), true);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, ".grok-plugin", "plugin.json")), false);
  assert.equal(fs.existsSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")), false);
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".grok-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].name, "codex");
  assert.match(marketplace.metadata.version, /grok/i);
});

test("slash commands are exposed as Grok-native skills", () => {
  for (const name of SLASH_COMMANDS) {
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
  assert.match(source, /\[Alias\(["']Profile["']\)\]/i);
  assert.match(source, /\[string\]\$CodexProfile/i);
  assert.doesNotMatch(source, /\[string\]\$Effort\s*=/i);
  assert.match(source, /\$PSBoundParameters\.ContainsKey\(["']Effort["']\)/i);
  assert.ok(
    source.indexOf('npm\\codex.cmd') < source.indexOf('Get-Command codex -ErrorAction'),
    "codex.cmd should be preferred over codex.ps1"
  );
});

test("Windows invoke-codex helper only applies explicit overrides and preserves exit codes", { skip: process.platform !== "win32" }, () => {
  const repo = makeTempDir("codex-pwsh-helper-");
  const helper = path.join(PLUGIN_ROOT, "scripts", "invoke-codex.ps1");
  const fakeCodex = path.join(repo, "fake-codex.cmd");
  const fakeCodexEntry = path.join(repo, "fake-codex.mjs");
  const argsFile = path.join(repo, "args.txt");
  fs.writeFileSync(
    fakeCodexEntry,
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      'fs.writeFileSync(process.env.CODEX_TEST_ARGS, `${args.join("\\n")}\\n`, "utf8");',
      'const outputIndex = args.indexOf("-o");',
      'if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], "fake result\\n", "utf8");',
      "process.exitCode = Number(process.env.CODEX_TEST_EXIT || 0);",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    fakeCodex,
    [
      "@echo off",
      `"${process.execPath}" "${fakeCodexEntry}" %*`,
      "exit /b %ERRORLEVEL%",
      ""
    ].join("\r\n"),
    "utf8"
  );

  const invoke = (extra = [], env = {}) =>
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
        env: { ...process.env, CODEX_TEST_ARGS: argsFile, ...env },
        encoding: "utf8",
        windowsHide: true
      }
    );

  const withoutProfile = invoke(["-OutName", "default.md"]);
  assert.equal(withoutProfile.status, 0, withoutProfile.stderr);
  let captured = fs.readFileSync(argsFile, "utf8");
  assert.doesNotMatch(captured, /^--profile$/m);
  assert.doesNotMatch(captured, /model_reasoning_effort=/);
  assert.equal(fs.existsSync(path.join(repo, "tmp", "codex-out", "default.md")), true);

  fs.writeFileSync(argsFile, "", "utf8");
  const withProfile = invoke(["-Profile", "codex-api", "-Effort", "ultra", "-OutName", "profile.md"]);
  assert.equal(withProfile.status, 0, withProfile.stderr);
  captured = fs.readFileSync(argsFile, "utf8");
  assert.match(captured, /^--profile\r?\ncodex-api$/m);
  assert.match(captured, /^model_reasoning_effort=ultra$/m);

  fs.writeFileSync(argsFile, "", "utf8");
  const failed = invoke(["-OutName", "failed.md"], { CODEX_TEST_EXIT: "17" });
  assert.equal(failed.status, 17, failed.stderr);
  assert.match(failed.stderr, /codex exited with code 17/i);
});

test("companion usage exposes host-controlled review flags and resume discovery", () => {
  const companion = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
  const result = spawnSync(process.execPath, [companion, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /review \[--wait\|--background\].*direct CLI stays foreground/);
  assert.match(result.stdout, /adversarial-review \[--wait\|--background\].*direct CLI stays foreground/);
  assert.match(result.stdout, /task-resume-candidate \[--json\]/);
  assert.doesNotMatch(result.stdout, /^\s+node .* task-worker/m);
});

test("stop review prompt keeps the shared task marker", () => {
  const template = read("prompts/stop-review-gate.md");
  assert.equal(template.includes(STOP_REVIEW_TASK_MARKER), true);
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
