import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLedgerPath } from "../plugins/codex/scripts/lib/codex.mjs";

test("normalizeLedgerPath strips Windows extended-length prefix", () => {
  const plain = "C:\\Users\\PC\\.claude\\projects\\-grok-codex-transfer\\a.jsonl";
  const extended = "\\\\?\\C:\\Users\\PC\\.claude\\projects\\-grok-codex-transfer\\a.jsonl";
  assert.equal(normalizeLedgerPath(plain), normalizeLedgerPath(extended));
  assert.match(normalizeLedgerPath(extended), /c:\/users\/pc\/\.claude\/projects\/-grok-codex-transfer\/a\.jsonl/i);
});

test("normalizeLedgerPath is stable for forward slashes", () => {
  const a = "C:/Users/PC/.claude/projects/-grok-codex-transfer/a.jsonl";
  const b = "C:\\Users\\PC\\.claude\\projects\\-grok-codex-transfer\\a.jsonl";
  assert.equal(normalizeLedgerPath(a), normalizeLedgerPath(b));
});
