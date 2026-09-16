// A plan only counts as "waiting for approval" when it actually has an action
// waiting on the user. Commands that understood nothing, and plans whose
// actions all run without asking, must never show up as pending approvals —
// otherwise the orb sits on APPROVAL REQUIRED and the command bar locks.
const test = require("node:test");
const assert = require("node:assert/strict");
const { isolate, startAgent, client } = require("./helpers");
isolate();

let agent, base, owner, c;
test.before(async () => { ({ agent, base } = await startAgent()); owner = agent.ownerDevice(); c = client(base, owner); });
test.after(() => agent.stop());

test("a command the planner did not understand is not a pending approval", async () => {
  const r = await c.call("command", { command: "תעשה לי קפה" });
  assert.equal(r.body.plan.actions.length, 0);
  assert.equal(r.body.plan.requires_approval, false);
  assert.equal((await c.call("plans/pending")).body.plans.length, 0);
});

test("a project suggestion is not a pending approval either", async () => {
  const r = await c.call("command", { command: "תעשה לי אתר בשביל מסעדה אטלקית" });
  assert.equal(r.body.plan.suggest, "projects");
  assert.equal((await c.call("plans/pending")).body.plans.length, 0);
});

test("a low-risk plan that runs on its own is not a pending approval", async () => {
  const r = await c.call("command", { command: "what time is it" });
  assert.equal(r.body.plan.requires_approval, false);
  assert.equal((await c.call("plans/pending")).body.plans.length, 0);
});

test("a plan with an action that asks IS a pending approval, and clears once answered", async () => {
  const r = await c.call("command", { command: "create file pending.txt with hi" });
  assert.equal(r.body.plan.requires_approval, true);
  const pending = (await c.call("plans/pending")).body.plans;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].plan_id, r.body.plan.plan_id);
  await c.call("plans/approve", { plan_id: r.body.plan.plan_id, actions_hash: r.body.plan.actions_hash, decision: "reject" });
  assert.equal((await c.call("plans/pending")).body.plans.length, 0);
});

test("many unknown commands never accumulate as approvals", async () => {
  for (const cmd of ["asdf", "תעשה לי קפה", "qwerty zzz", "מה נשמע איתך"]) await c.call("command", { command: cmd });
  assert.equal((await c.call("plans/pending")).body.plans.length, 0);
});
