import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";

test("splitRawArgumentString preserves apostrophes in free-form text", () => {
  assert.deepEqual(splitRawArgumentString("it's broken"), ["it's broken"]);
  assert.deepEqual(splitRawArgumentString("don't do that"), ["don't do that"]);
});

test("splitRawArgumentString preserves quotes, backslashes, and whitespace in free-form text", () => {
  assert.deepEqual(
    splitRawArgumentString(String.raw`challenge the "caching" design`),
    [String.raw`challenge the "caching" design`]
  );
  assert.deepEqual(splitRawArgumentString(String.raw`focus C:\src\app regex \d+`), [
    String.raw`focus C:\src\app regex \d+`
  ]);
});

test("splitRawArgumentString separates known flags from an unchanged free-form remainder", () => {
  assert.deepEqual(
    splitRawArgumentString(String.raw`--base main challenge the "caching" design`),
    ["--base", "main", String.raw`challenge the "caching" design`]
  );
  assert.deepEqual(
    splitRawArgumentString(String.raw`--base "my branch" focus text`),
    ["--base", "my branch", "focus text"]
  );
  assert.deepEqual(
    splitRawArgumentString(String.raw`--base="my branch" --background focus text`),
    ["--base=my branch", "--background", "focus text"]
  );
});

test("splitRawArgumentString keeps shell metacharacters as inert free-form data", () => {
  const focus = "check $(whoami) and `whoami`; rm -rf /";
  assert.deepEqual(splitRawArgumentString(focus), [focus]);
});

test("parseArgs stops routing flag parsing after free-form text starts", () => {
  const parsed = parseArgs(
    splitRawArgumentString(
      String.raw`--base main --background challenge the "caching" design --json`
    ),
    {
      valueOptions: ["base"],
      booleanOptions: ["background", "json"],
      stopAtFirstPositional: true
    }
  );

  assert.deepEqual(parsed.options, { base: "main", background: true });
  assert.deepEqual(parsed.positionals, [String.raw`challenge the "caching" design --json`]);
});

test("full raw parsing preserves job ids and quoted --source paths", () => {
  const status = parseArgs(
    splitRawArgumentString("review-123 --json", { preserveRemainder: false }),
    { booleanOptions: ["json"] }
  );
  assert.deepEqual(status, {
    options: { json: true },
    positionals: ["review-123"]
  });

  const sourcePath = String.raw`C:\Users\Test User\session.jsonl`;
  const transfer = parseArgs(
    splitRawArgumentString(`--source "${sourcePath}" --json`, { preserveRemainder: false }),
    { valueOptions: ["source"], booleanOptions: ["json"] }
  );
  assert.deepEqual(transfer, {
    options: { source: sourcePath, json: true },
    positionals: []
  });
});

test("-- passthrough preserves the remaining free-form text exactly", () => {
  const focus = String.raw`challenge the "caching" design --background`;
  const tokens = splitRawArgumentString(`-- ${focus}`);
  assert.deepEqual(tokens, ["--", focus]);
  assert.deepEqual(
    parseArgs(tokens, {
      booleanOptions: ["background"],
      stopAtFirstPositional: true
    }),
    { options: {}, positionals: [focus] }
  );
});
