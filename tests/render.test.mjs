import test from "node:test";
import assert from "node:assert/strict";

import {
  renderReviewResult,
  renderSetupReport,
  renderStoredJobResult
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderSetupReport shows the state directory and fallback warning", () => {
  const output = renderSetupReport({
    ready: true,
    node: { detail: "node ok" },
    npm: { detail: "npm ok" },
    codex: { detail: "codex ok" },
    auth: { detail: "auth ok" },
    sessionRuntime: { label: "direct" },
    stateDir: "C:\\Temp\\codex-companion\\repo-1234",
    usingFallbackStateDir: true,
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  });

  assert.match(output, /state directory: C:\\Temp\\codex-companion\\repo-1234/);
  assert.match(output, /system temporary directory/i);
  assert.match(output, /job records to be lost/i);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
