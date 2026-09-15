const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../src/core/policy");

const low = { name: "t_low", risk: "low", reversible: true };
const lowIrrev = { name: "t_low_irrev", risk: "low", reversible: false };
const med = { name: "t_med", risk: "medium" };
const high = { name: "t_high", risk: "high" };

test("emergency stop denies everything", () => {
  assert.equal(decide({ tool: low, mode: "assistant", emergency: true }).decision, "deny");
});

test("safe mode: only low + reversible", () => {
  assert.equal(decide({ tool: low, mode: "safe" }).decision, "allow");
  assert.equal(decide({ tool: lowIrrev, mode: "safe" }).decision, "deny");
  assert.equal(decide({ tool: med, mode: "safe" }).decision, "deny");
  assert.equal(decide({ tool: high, mode: "safe" }).decision, "deny");
});

test("assistant mode: low allow, medium ask, high ask + second confirmation", () => {
  assert.equal(decide({ tool: low, mode: "assistant" }).decision, "allow");
  const m = decide({ tool: med, mode: "assistant", planId: "p" });
  assert.equal(m.decision, "ask");
  assert.ok(m.taskApprovable);
  const h = decide({ tool: high, mode: "assistant" });
  assert.equal(h.decision, "ask");
  assert.ok(h.secondConfirmation);
});

test("task approval covers medium tools for that plan only", () => {
  const ta = new Set(["p1:t_med"]);
  assert.equal(decide({ tool: med, mode: "assistant", planId: "p1", taskApproved: ta }).decision, "allow");
  assert.equal(decide({ tool: med, mode: "assistant", planId: "p2", taskApproved: ta }).decision, "ask");
  assert.equal(decide({ tool: high, mode: "assistant", planId: "p1", taskApproved: new Set(["p1:t_high"]) }).decision, "ask");
});

test("advanced mode honours per-tool policy but never weakens high risk", () => {
  assert.equal(decide({ tool: med, mode: "advanced", toolPolicies: { t_med: "allowed" } }).decision, "allow");
  assert.equal(decide({ tool: med, mode: "advanced", toolPolicies: { t_med: "ask_every_time" } }).decision, "ask");
  assert.equal(decide({ tool: med, mode: "advanced", toolPolicies: { t_med: "blocked" } }).decision, "deny");
  assert.equal(decide({ tool: low, mode: "advanced", toolPolicies: { t_low: "blocked" } }).decision, "deny");
  assert.equal(decide({ tool: high, mode: "advanced", toolPolicies: { t_high: "allowed" } }).decision, "ask");
  assert.equal(decide({ tool: high, mode: "assistant", toolPolicies: { t_high: "blocked" } }).decision, "deny");
});
