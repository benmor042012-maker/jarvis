// The states the product must handle honestly: offline agent, no local model,
// denied permission, expired/replayed requests, cancellation, emergency stop,
// no provider, and "nothing is ever sent".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isolate, startAgent, client } = require("./helpers");
const home = isolate();

let agent, base, owner, c;
// provider "auto" so the real "look for Ollama/LocalAI, find none" path runs.
test.before(async () => { ({ agent, base } = await startAgent({ config: { ai: { provider: "auto" } } })); owner = agent.ownerDevice(); c = client(base, owner); });
test.after(() => agent.stop());

test("offline agent: the client gets a connection error, never a fake success", async () => {
  const { agent: a2, base: b2 } = await startAgent();
  const own2 = a2.ownerDevice();
  const c2 = client(b2, own2);
  assert.equal((await c2.call("status")).status, 200);
  a2.stop();
  await assert.rejects(() => fetch(b2 + "/api/health"), /fetch failed|ECONNREFUSED/);
});

test("no local model: MOCK MODE is reported, not hidden", async () => {
  // Auto-detect, so this exercises the real "look for Ollama/LocalAI, find none" path.
  await c.call("settings/update", { settings: { ai: { provider: "auto" } } });
  const ai = await c.call("ai/detect", { force: true });
  assert.equal(ai.body.mock_mode, true);
  assert.match(ai.body.active.reason, /no local model found/);
  const p = await c.call("command", { command: "open notepad" });
  assert.equal(p.body.plan.mock, true);
  assert.equal(p.body.plan.provider, "mock");
  assert.match(p.body.plan.notes.join(" "), /rule planner/);
});

test("unavailable tool on this platform reports the technical reason, and is never executed", async () => {
  if (process.platform === "win32") return;
  const p = await c.call("command", { command: "type hello world" });
  const a = p.body.plan.actions[0];
  assert.equal(a.available, false);
  assert.match(a.unavailable_reason, /Windows/);
  assert.equal(a.decision, "deny");
  const ex = await c.call("plans/execute", { plan_id: p.body.plan.plan_id });
  let j = ex.body.job;
  for (let i = 0; i < 50 && (j.status === "running" || j.status === "queued"); i++) { await new Promise((r) => setTimeout(r, 20)); j = (await c.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "denied");
  assert.match(j.results[0].summary, /Windows/);
});

test("expired envelope, replayed nonce and duplicated id are all refused over HTTP", async () => {
  const { sign } = require("../src/core/protocol");
  const { uuid, randomHex } = require("../src/core/util");
  const post = async (env) => {
    const res = await fetch(base + "/api/status", { method: "POST", body: JSON.stringify(env), headers: { "content-type": "application/json" } });
    return { status: res.status, body: await res.json() };
  };
  const now = Date.now();
  const expired = sign({ v: 1, id: uuid(), device_id: owner.id, ts: now - 70000, expires: now - 5000, nonce: randomHex(8), params: {} }, owner.secret, "POST", "/api/status");
  assert.equal((await post(expired)).body.error, "expired");
  const good = sign({ v: 1, id: uuid(), device_id: owner.id, ts: now, expires: now + 60000, nonce: randomHex(8), params: {} }, owner.secret, "POST", "/api/status");
  assert.equal((await post(good)).status, 200);
  assert.equal((await post(good)).body.error, "duplicated");
  const sameNonce = sign({ v: 1, id: uuid(), device_id: owner.id, ts: now, expires: now + 60000, nonce: good.nonce, params: {} }, owner.secret, "POST", "/api/status");
  assert.equal((await post(sameNonce)).body.error, "replayed");
});

test("cancellation stops the job and kills the child process tree", async () => {
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  const plan = agent.executor._storePlan({
    command: "long job", message: "m", provider: "mock", mock: true, device: owner,
    actions: [{ tool: "run_command", params: { program: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd: path.join(home, "workspace"), timeout_seconds: 120 } }],
  });
  const approve = await c.call("plans/approve", { plan_id: plan.plan_id, actions_hash: plan.actions_hash, decision: "approve" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const procs = require("../src/core/procs");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(procs.count() > 0, "a child process should be running");
  await c.call("jobs/cancel", { job_id: approve.body.job.job_id });
  let j = approve.body.job;
  for (let i = 0; i < 100 && (j.status === "running" || j.status === "queued"); i++) { await new Promise((r) => setTimeout(r, 50)); j = (await c.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "cancelled");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(procs.count(), 0, "the child process tree should be gone");
});

test("emergency stop kills running work and refuses everything until cleared", async () => {
  const plan = agent.executor._storePlan({
    command: "long job", message: "m", provider: "mock", mock: true, device: owner,
    actions: [{ tool: "run_command", params: { program: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd: path.join(home, "workspace"), timeout_seconds: 120 } }],
  });
  const approve = await c.call("plans/approve", { plan_id: plan.plan_id, actions_hash: plan.actions_hash, decision: "approve" });
  await new Promise((r) => setTimeout(r, 400));
  const stop = await c.call("emergency-stop");
  assert.ok(stop.body.stopped.killed_processes >= 1 || stop.body.stopped.cancelled_jobs >= 1);
  const blocked = await c.call("command", { command: "what time is it" });
  assert.equal(blocked.body.plan.denied, "emergency_stopped");
  const exec = await c.call("plans/execute", { plan_id: blocked.body.plan.plan_id });
  assert.equal(exec.status, 423);
  assert.equal(exec.body.error, "emergency_stopped");
  assert.equal(require("../src/core/procs").count(), 0);
  await c.call("emergency-clear");
  assert.equal((await c.call("status")).body.emergency, false);
  void approve;
});

test("nothing is ever sent: no send route, no adapter, drafts are files only", async () => {
  const routes = [...agent.server.routes.keys()];
  assert.ok(!routes.some((r) => /send|smtp|whatsapp|telegram|sms/i.test(r)), routes.join(","));
  const tools = agent.registry.list({ cfg: agent.cfg() }).map((t) => t.name);
  assert.ok(!tools.some((t) => /send|smtp|whatsapp|telegram|sms/i.test(t)), tools.join(","));
  const d = await c.call("drafts/create", { recipient: "a@b.c", purpose: "thanks", language: "en", name: "A" });
  assert.equal(d.body.draft.label, "DRAFT ONLY — NOTHING IS SENT");
  const status = await c.call("status");
  assert.equal(status.body.cost_network.outgoing_messages, 0);
});

test("no provider configured: there is nowhere to configure one", async () => {
  const s = await c.call("settings/get");
  const text = JSON.stringify(s.body.settings);
  assert.ok(!/api[_-]?key|token|secret|password/i.test(text), text);
  assert.deepEqual(Object.keys(s.body.settings.ai).sort(), ["localaiUrl", "model", "ollamaUrl", "provider", "timeoutMs"]);
});

test("offline mode blocks network tools with a reason instead of faking them", async () => {
  await c.call("settings/update", { settings: { offlineMode: true } });
  const p = await c.call("projects/plan", { name: "off-proj", template: "desktop" });
  assert.equal(p.body.task.commands.find((x) => x.step === "install").offline_blocked, true);
  assert.match(p.body.task.publish, /offline mode/);
  await c.call("settings/update", { settings: { offlineMode: false } });
});

test("an emergency stop says what stopped it, in the very first event", async () => {
  const seen = [];
  const onEvent = (e) => { if (e.type === "status") seen.push(e.status.emergency_source); };
  agent.on("event", onEvent);
  agent.emergencyStop("voice:עצור");
  agent.off("event", onEvent);
  // The status event fires while the stop is still being applied, so the source
  // has to be in place before it — otherwise every screen reads "unknown".
  assert.ok(seen.length >= 1, "an emergency stop must emit a status event");
  assert.equal(seen[0], "voice:עצור");
  assert.equal(agent.status().emergency_source, "voice:עצור");
  agent.clearEmergency({ name: "test" });
});
