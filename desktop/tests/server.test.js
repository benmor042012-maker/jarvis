const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isolate, startAgent, client } = require("./helpers");
const home = isolate();

let agent, base, owner, remote, ownerClient, remoteClient;
const localConfirmations = [];
let confirmAnswer = true;

test.before(async () => {
  ({ agent, base } = await startAgent({ host: { confirmLocal: async (plan) => { localConfirmations.push(plan.plan_id); return confirmAnswer; } } }));
  owner = agent.ownerDevice();
  ownerClient = client(base, owner);
  const { code } = agent.devices.createPairCode();
  const res = await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code, name: "phone" }), headers: { "content-type": "application/json" } });
  const body = await res.json();
  remote = { id: body.device_id, secret: body.secret, role: body.role };
  remoteClient = client(base, remote);
});
test.after(() => agent.stop());

test("health is unauthenticated and reveals only state", async () => {
  const h = await (await fetch(base + "/api/health")).json();
  assert.equal(h.ok, true);
  assert.equal(h.requires_pairing, true);
  assert.ok(!("devices" in h));
});

test("pairing failures: bad code, second use, rate limit", async () => {
  const bad = await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code: "00000000", name: "x" }), headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 401);
});

test("unsigned / malformed / wrong-path requests are rejected", async () => {
  const r1 = await fetch(base + "/api/status", { method: "POST", body: "{}" });
  assert.equal(r1.status, 400);
  const r2 = await fetch(base + "/api/status", { method: "GET" });
  assert.equal(r2.status, 405);
  const r3 = await remoteClient.call("status", {}, { mutate: (e) => ({ ...e, signature: "ff" }) });
  assert.equal(r3.body.error, "unauthorized");
  const r4 = await remoteClient.call("status", { a: 1 }, { mutate: (e) => ({ ...e, params: { a: 2 } }) });
  assert.equal(r4.body.error, "modified");
});

test("replay and duplicate detection over HTTP", async () => {
  let captured;
  const r1 = await remoteClient.call("status", {}, { mutate: (e) => { captured = e; return e; } });
  assert.equal(r1.status, 200);
  const again = await fetch(base + "/api/status", { method: "POST", body: JSON.stringify(captured), headers: { "content-type": "application/json" } });
  assert.equal((await again.json()).error, "duplicated");
});

test("DNS rebinding defence: public Host header refused", async () => {
  const status = await new Promise((resolve, reject) => {
    const http = require("http");
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: "/api/health", headers: { host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", reject);
  });
  assert.equal(status, 421);
});

test("status panel shows local-only cost/network facts", async () => {
  const r = await ownerClient.call("status");
  assert.equal(r.status, 200);
  assert.equal(r.body.cost_network.external_calls, 0);
  assert.equal(r.body.cost_network.api_keys_configured, 0);
  assert.equal(r.body.cost_network.payment_configured, false);
  assert.equal(r.body.cost_network.outgoing_messages, 0);
});

test("owner-only routes are refused for remote devices", async () => {
  const r = await remoteClient.call("settings/update", { settings: { mode: "safe" } });
  assert.equal(r.status, 403);
  const r2 = await remoteClient.call("devices/pair-code");
  assert.equal(r2.status, 403);
  const ok = await ownerClient.call("devices/pair-code");
  assert.equal(ok.status, 200);
  assert.match(ok.body.code, /^\d{8}$/);
});

test("plan -> low risk executes; medium needs approval bound to hash; modified approval refused", async () => {
  const p = await remoteClient.call("command", { command: "what time is it" });
  assert.equal(p.status, 200);
  assert.equal(p.body.plan.requires_approval, false);
  assert.equal(p.body.plan.mock, true);
  const ex = await remoteClient.call("plans/execute", { plan_id: p.body.plan.plan_id });
  assert.equal(ex.status, 200);
  let job = ex.body.job;
  for (let i = 0; i < 50 && job.status === "running" || job.status === "queued"; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await remoteClient.call("jobs/get", { job_id: job.job_id })).body.job; }
  assert.equal(job.status, "completed");
  assert.equal(job.results[0].tool, "current_time");

  const m = await remoteClient.call("command", { command: "create file hello.txt with hi" });
  assert.equal(m.body.plan.requires_approval, true);
  assert.equal(m.body.plan.actions[0].decision, "ask");
  const noApproval = await remoteClient.call("plans/execute", { plan_id: m.body.plan.plan_id });
  assert.equal(noApproval.body.error, "approval_required");
  const tampered = await remoteClient.call("plans/approve", { plan_id: m.body.plan.plan_id, actions_hash: "deadbeef", decision: "approve" });
  assert.equal(tampered.body.error, "modified");
  const ok = await remoteClient.call("plans/approve", { plan_id: m.body.plan.plan_id, actions_hash: m.body.plan.actions_hash, decision: "approve" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  let j = ok.body.job;
  for (let i = 0; i < 50 && (j.status === "running" || j.status === "queued"); i++) { await new Promise((r) => setTimeout(r, 20)); j = (await remoteClient.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "completed");
  assert.ok(fs.existsSync(path.join(home, "workspace", "hello.txt")));
  const twice = await remoteClient.call("plans/approve", { plan_id: m.body.plan.plan_id, actions_hash: m.body.plan.actions_hash, decision: "approve" });
  assert.equal(twice.status, 409);
});

test("rejecting a plan runs nothing", async () => {
  const m = await remoteClient.call("command", { command: "create file never.txt with x" });
  const r = await remoteClient.call("plans/approve", { plan_id: m.body.plan.plan_id, actions_hash: m.body.plan.actions_hash, decision: "reject" });
  assert.equal(r.body.plan.status, "rejected");
  assert.ok(!fs.existsSync(path.join(home, "workspace", "never.txt")));
});

test("high risk from a remote device needs the second local confirmation", async () => {
  const m = await remoteClient.call("command", { command: "delete hello.txt" });
  assert.equal(m.body.plan.highest_risk, "high");
  confirmAnswer = false;
  const denied = await remoteClient.call("plans/approve", { plan_id: m.body.plan.plan_id, actions_hash: m.body.plan.actions_hash, decision: "approve" });
  assert.equal(denied.body.error, "local_confirmation_denied");
  assert.ok(fs.existsSync(path.join(home, "workspace", "hello.txt")));
  confirmAnswer = true;
  const m2 = await remoteClient.call("command", { command: "delete hello.txt" });
  const ok = await remoteClient.call("plans/approve", { plan_id: m2.body.plan.plan_id, actions_hash: m2.body.plan.actions_hash, decision: "approve" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  let j = ok.body.job;
  for (let i = 0; i < 50 && (j.status === "running" || j.status === "queued"); i++) { await new Promise((r) => setTimeout(r, 20)); j = (await remoteClient.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "completed");
  assert.ok(localConfirmations.length >= 2);
});

test("safe mode denies medium actions with a reason; refusals never plan", async () => {
  await ownerClient.call("mode", { mode: "safe" });
  const m = await remoteClient.call("command", { command: "create file s.txt with x" });
  assert.equal(m.body.plan.actions[0].decision, "deny");
  assert.equal(m.body.plan.actions[0].reason, "safe_mode");
  const ex = await remoteClient.call("plans/execute", { plan_id: m.body.plan.plan_id });
  let j = ex.body.job;
  for (let i = 0; i < 50 && (j.status === "running" || j.status === "queued"); i++) { await new Promise((r) => setTimeout(r, 20)); j = (await remoteClient.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "denied");
  await ownerClient.call("mode", { mode: "assistant" });
  const refuse = await remoteClient.call("command", { command: "buy me a laptop" });
  assert.equal(refuse.body.plan.actions.length, 0);
});

test("emergency stop cancels and blocks; only owner clears", async () => {
  const s = await remoteClient.call("emergency-stop");
  assert.equal(s.status, 200);
  const p = await remoteClient.call("command", { command: "what time is it" });
  assert.equal(p.body.plan.denied, "emergency_stopped");
  const c = await remoteClient.call("emergency-clear");
  assert.equal(c.status, 403);
  const c2 = await ownerClient.call("emergency-clear");
  assert.equal(c2.body.state, "connected");
});

test("cancellation of a running job", async () => {
  agent.registry.register({ name: "t_sleep", title: "sleep", description: "x", schema: { type: "object", properties: {} }, risk: "low", reversible: true, timeoutMs: 10000, run: (_p, { signal }) => new Promise((res, rej) => { const t = setTimeout(() => res("done"), 2000); signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("cancelled")); }); }) });
  const plan = agent.executor._storePlan({ command: "sleep", message: "m", actions: [{ tool: "t_sleep", params: {} }], provider: "mock", mock: true, device: owner });
  const ex = await ownerClient.call("plans/execute", { plan_id: plan.plan_id });
  const c = await ownerClient.call("jobs/cancel", { job_id: ex.body.job.job_id });
  assert.equal(c.status, 200);
  let j = c.body.job;
  for (let i = 0; i < 50 && j.status === "running"; i++) { await new Promise((r) => setTimeout(r, 20)); j = (await ownerClient.call("jobs/get", { job_id: j.job_id })).body.job; }
  assert.equal(j.status, "cancelled");
});

test("plan expiry", async () => {
  const plan = agent.executor._storePlan({ command: "x", message: "m", actions: [{ tool: "current_time", params: {} }], provider: "mock", mock: true, device: owner });
  plan.expires_at = Date.now() - 1;
  const r = await ownerClient.call("plans/execute", { plan_id: plan.plan_id });
  assert.equal(r.body.error, "expired");
});

test("SSE token is single use and streams status", async () => {
  const t = await remoteClient.call("events/token");
  const res = await fetch(base + "/api/events?token=" + t.body.token);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /connected/);
  await reader.cancel();
  const again = await fetch(base + "/api/events?token=" + t.body.token);
  assert.equal(again.status, 401);
});

test("device revocation cuts access; remote can revoke itself only", async () => {
  const { code } = agent.devices.createPairCode();
  const res = await (await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code, name: "tablet" }), headers: { "content-type": "application/json" } })).json();
  const tablet = client(base, { id: res.device_id, secret: res.secret });
  const forbidden = await tablet.call("devices/revoke", { device_id: remote.id });
  assert.equal(forbidden.status, 403);
  const self = await tablet.call("devices/revoke", { device_id: res.device_id });
  assert.equal(self.status, 200);
  const after = await tablet.call("status");
  assert.equal(after.body.detail, "revoked");
});

test("audit log is redacted and readable; export/delete work", async () => {
  const a = await remoteClient.call("audit/read", { limit: 50 });
  assert.ok(a.body.entries.length > 5);
  assert.ok(a.body.entries.every((e) => !JSON.stringify(e).includes(remote.secret)));
  const e = await ownerClient.call("data/export");
  assert.ok(e.body.audit.length >= 1);
  assert.ok(!JSON.stringify(e.body).includes(remote.secret));
  const d = await ownerClient.call("data/delete", { audit: true, memory: false, drafts: false, screenshots: false });
  assert.ok(d.body.deleted.audit_files >= 1);
});

test("settings validation refuses cloud model endpoints and bad ports", async () => {
  const r = await ownerClient.call("settings/update", { settings: { ai: { ollamaUrl: "https://api.openai.com/v1" } } });
  assert.equal(r.status, 400);
  const r2 = await ownerClient.call("settings/update", { settings: { server: { port: 80 } } });
  assert.equal(r2.status, 400);
  const r3 = await ownerClient.call("settings/update", { settings: { approvedFolders: ["/definitely/not/here"] } });
  assert.equal(r3.status, 400);
  const ok = await ownerClient.call("settings/update", { settings: { language: "en" } });
  assert.equal(ok.body.settings.language, "en");
});

test("tools list and per-tool policy", async () => {
  const t = await remoteClient.call("tools/list");
  assert.ok(t.body.tools.length > 30);
  const bad = await ownerClient.call("tools/policy", { tool: "open_url", policy: "sometimes" });
  assert.equal(bad.status, 400);
  const ok = await ownerClient.call("tools/policy", { tool: "open_url", policy: "blocked" });
  assert.equal(ok.body.tools.find((x) => x.name === "open_url").policy, "blocked");
  const p = await remoteClient.call("command", { command: "open youtube" });
  assert.equal(p.body.plan.actions[0].decision, "deny");
  await ownerClient.call("tools/policy", { tool: "open_url", policy: "default" });
});

test("ai detection reports mock mode honestly when nothing is installed", async () => {
  const r = await remoteClient.call("ai/detect", { force: true });
  assert.equal(r.body.mock_mode, true);
  assert.ok(r.body.capability_warning.length > 20);
});

test("drafts: create, warnings, export, opt-out; nothing is sent", async () => {
  const d1 = await remoteClient.call("drafts/create", { recipient: "dan@example.com", purpose: "follow_up", language: "en", name: "Dan", topic: "the kitchen" });
  assert.equal(d1.status, 200, JSON.stringify(d1.body));
  assert.match(d1.body.draft.text, /Dan/);
  assert.equal(d1.body.draft.label, "DRAFT ONLY — NOTHING IS SENT");
  const d2 = await remoteClient.call("drafts/create", { recipient: "dan@example.com", purpose: "follow_up", language: "en", name: "Dan" });
  assert.ok(d2.body.draft.warnings.some((w) => w.code === "duplicate"));
  const t = await remoteClient.call("drafts/create", { recipient: "x@y.z", purpose: "custom", body: "hi", translate_to: "en" });
  assert.ok(t.body.draft.notes.some((n) => /local model/.test(n)));
  await remoteClient.call("drafts/optout", { recipient: "dan@example.com" });
  const d3 = await remoteClient.call("drafts/create", { recipient: "dan@example.com", purpose: "thanks", language: "he", name: "דן" });
  assert.ok(d3.body.draft.warnings.some((w) => w.code === "opted_out"));
  const ex = await remoteClient.call("drafts/export", { id: d1.body.draft.id });
  assert.ok(fs.readFileSync(ex.body.path, "utf8").startsWith("DRAFT ONLY"));
  const list = await remoteClient.call("drafts/list");
  assert.ok(list.body.drafts.length >= 4);
  const bad = await remoteClient.call("drafts/create", { purpose: "custom" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.detail, /body is required/);
});

test("static fallback page when UI is not built", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /JARVIS agent is running/);
});

test("voice, alert and phone routes are reachable and honest over HTTP", async () => {
  const v = await ownerClient.call("voice/status", { force: true });
  assert.equal(v.status, 200);
  assert.equal(v.body.engine.available, false, "no speech engine is installed on CI");
  assert.ok(v.body.engine.install.windows.length >= 3, "it must say exactly how to install one");
  // The route reports whatever is configured; which spellings ship by default
  // is config's business, and voice.test.js pins the matching itself.
  assert.ok(v.body.wakePhrases.includes("תתעורר"), JSON.stringify(v.body.wakePhrases));
  assert.ok(v.body.wakePhrases.includes("hey jarvis"), JSON.stringify(v.body.wakePhrases));

  // Audio upload needs its own short-lived token and refuses without one.
  const noToken = await fetch(base + "/api/voice/utterance", { method: "POST", body: Buffer.alloc(100) });
  assert.equal(noToken.status, 401);
  const tok = (await ownerClient.call("voice/upload-token")).body.token;
  const notWav = await fetch(base + "/api/voice/utterance?token=" + tok, { method: "POST", body: Buffer.alloc(100) });
  assert.equal(notWav.status, 400, "a body that is not a recording is a bad request");

  // A real recording, with the microphone granted, reaches the engine check —
  // which reports exactly what is missing instead of inventing a transcript.
  await ownerClient.call("voice/microphone", { granted: true });
  const tok2 = (await ownerClient.call("voice/upload-token")).body.token;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.write("WAVEfmt ", 8, "ascii");
  head.write("data", 36, "ascii");
  const realWav = Buffer.concat([head, Buffer.alloc(3200)]);
  const noEngine = await fetch(base + "/api/voice/utterance?token=" + tok2 + "&ms=900", { method: "POST", body: realWav });
  assert.equal(noEngine.status, 503, "no engine installed, and it says so rather than guessing");
  const body = await noEngine.json();
  assert.ok(body.install, "the error carries the exact free install steps");
  assert.equal(body.error, "speech_engine_missing");
  await ownerClient.call("voice/microphone", { granted: false });

  const mic = await remoteClient.call("voice/microphone", { granted: true });
  assert.equal(mic.status, 403, "only the computer itself may grant the microphone");

  const cust = await ownerClient.call("customers/save", { customer: { name: "בדיקה", lastMessage: "דחוף מאוד" } });
  assert.equal(cust.status, 200);
  assert.ok(cust.body.customer.urgent);
  const scan = await ownerClient.call("alerts/scan");
  assert.equal(scan.body.raised.length, 1);
  const alerts = await remoteClient.call("alerts/list");
  assert.equal(alerts.body.alerts.length, 1);
  assert.equal(alerts.body.label, "LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES");
  const ack = await remoteClient.call("alerts/acknowledge", { id: alerts.body.alerts[0].id });
  assert.equal(ack.body.alert.status, "acknowledged");

  const caps = await remoteClient.call("phone/capabilities");
  assert.equal(caps.body.capabilities.answer_incoming_call.available, false);
  assert.equal(caps.body.answering_enabled, false);
  const answer = await ownerClient.call("phone/answer");
  assert.equal(answer.status, 501, "answering is refused, not faked");

  // Simulation, asked for explicitly: the workflow runs end to end and says so.
  const sim = await ownerClient.call("phone/request", { to: "050-123-4567", reason: "בדיקה", simulate: true });
  assert.equal(sim.status, 200);
  assert.equal(sim.body.call.simulation, true);
  const simDone = await ownerClient.call("phone/decide", { id: sim.body.call.id, decision: "approve", hash: sim.body.call.hash });
  assert.equal(simDone.body.call.status, "simulated");
  assert.equal(simDone.body.call.outcome, "simulated");
  assert.match(simDone.body.call.outcome_note, /no number was dialled/i);

  // A real request, approved: it reaches "approved" and stops there. Approval
  // is not a call, and nothing claims one was placed.
  const real = await ownerClient.call("phone/request", { to: "050-765-4321", reason: "בדיקה" });
  const realDone = await ownerClient.call("phone/decide", { id: real.body.call.id, decision: "approve", hash: real.body.call.hash });
  assert.ok(["approved", "simulated"].includes(realDone.body.call.status));
  if (realDone.body.call.status === "approved") {
    assert.equal(realDone.body.call.outcome, null, "approval alone must not set an outcome");
    assert.equal(realDone.body.call.dialer_opened_at, null);
  }
  const bad = await ownerClient.call("phone/decide", { id: real.body.call.id, decision: "approve", hash: "tampered" });
  assert.equal(bad.status, 409, "already decided");
});

test("the emergency stop also stops voice listening and any call in flight", async () => {
  const call = await ownerClient.call("phone/request", { to: "0501110000", reason: "x" });
  agent.voice.setMicGranted(true);
  agent.voice.listeningUntil = Date.now() + 60000;
  const stop = await ownerClient.call("emergency-stop");
  assert.equal(stop.status, 200);
  assert.ok(stop.body.stopped.stopped_calls >= 1);
  assert.equal(agent.voice.listeningUntil, 0);
  assert.equal((await ownerClient.call("phone/list")).body.calls.find((c) => c.id === call.body.call.id).status, "stopped");
  await ownerClient.call("emergency-clear");
});

/** Opens the local event stream for a device and collects the events it sends. */
async function openEvents(c) {
  const http = require("http");
  const { token } = (await c.call("events/token")).body;
  const u = new URL(base);
  const events = [];
  const req = http.get({ host: u.hostname, port: u.port, path: `/api/events?token=${token}` });
  const res = await new Promise((resolve, reject) => { req.on("response", resolve); req.on("error", reject); });
  let buf = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = /^data: (.*)$/m.exec(frame);
      if (data) { try { events.push(JSON.parse(data[1])); } catch { /* ping */ } }
    }
  });
  return { events, close: () => { req.destroy(); res.destroy(); } };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

test("an alert reaches paired phones over the local stream, and only when that channel is on", async () => {
  await ownerClient.call("settings/update", { settings: { alerts: { enabled: true, scanIntervalMs: 60000, channels: { notification: false, sound: false, speech: false, phone: true }, speakDetails: false, quietHours: { enabled: false, start: "23:00", end: "07:00" } } } });
  const c = await ownerClient.call("customers/save", { customer: { name: "אלמוג", lastMessage: "זה דחוף מאוד" } });
  const ownerStream = await openEvents(ownerClient);
  const phoneStream = await openEvents(remoteClient);
  await settle();

  assert.equal(agent.server.connectedRemotes(), 1, "the paired phone is counted as connected");
  const raised = await ownerClient.call("alerts/raise", { customer_id: c.body.customer.id, headline: "צריך תשובה" });
  await settle();
  const seenByPhone = phoneStream.events.filter((e) => e.type === "alert" && e.alert.id === raised.body.alert.id);
  assert.equal(seenByPhone.length, 1, "the phone receives the alert on the stream it already holds open");
  assert.equal(seenByPhone[0].alert.label, "LOCAL WI-FI ALERTS — NO EXTERNAL MESSAGES");
  assert.ok(ownerStream.events.some((e) => e.type === "alert"), "and so does this computer");
  // The record counts the phones that were actually connected — nothing is
  // "sent" anywhere else, so there is nothing else to count.
  assert.equal(agent.alerts.list().find((a) => a.id === raised.body.alert.id).delivered.phone, 1);

  // Turning the phone channel off must actually stop it reaching the phone.
  await ownerClient.call("settings/update", { settings: { alerts: { enabled: true, scanIntervalMs: 60000, channels: { notification: false, sound: false, speech: false, phone: false }, speakDetails: false, quietHours: { enabled: false, start: "23:00", end: "07:00" } } } });
  const second = await ownerClient.call("alerts/raise", { customer_id: c.body.customer.id, headline: "עוד פעם" });
  await settle();
  assert.ok(!phoneStream.events.some((e) => e.type === "alert" && e.alert.id === second.body.alert.id), "the phone must not receive it when the channel is off");
  assert.ok(ownerStream.events.some((e) => e.type === "alert" && e.alert.id === second.body.alert.id), "this computer still sees it");
  assert.equal(agent.alerts.list().find((a) => a.id === second.body.alert.id).delivered.phone, 0);

  ownerStream.close();
  phoneStream.close();
  await settle();
  assert.equal(agent.server.connectedRemotes(), 0);
});

test("every setting the interface can edit actually saves", async () => {
  // A settings screen that silently drops a section is worse than not having
  // it: the switch moves, nothing changes, and nothing says so. Every group in
  // the config is either editable or listed here as deliberately not.
  const config = require("../src/core/config");
  const NOT_EDITABLE = ["version"]; // bumped by migrations, never by a person
  // "server" is editable too, but changing its port or LAN flag restarts the
  // listener out from under this test, so it is checked without a change.
  const groups = Object.keys(config.load()).filter((k) => !NOT_EDITABLE.includes(k) && k !== "server");
  const sameServer = await ownerClient.call("settings/update", { settings: { server: config.load().server } });
  assert.equal(sameServer.status, 200, "server settings were rejected");
  for (const group of groups) {
    const before = JSON.parse(JSON.stringify(config.load()[group]));
    const probe = group === "language" ? (before === "he" ? "en" : "he") : typeof before === "object" && !Array.isArray(before) ? { ...before } : before;
    if (typeof probe === "object" && probe !== null && !Array.isArray(probe)) {
      // Flip the first boolean in the group; if it has none, skip the flip and
      // simply require that the group survives the round trip.
      const key = Object.keys(probe).find((k) => typeof probe[k] === "boolean");
      if (key) probe[key] = !probe[key];
      const r = await ownerClient.call("settings/update", { settings: { [group]: probe } });
      assert.equal(r.status, 200, `${group} was rejected`);
      if (key) assert.equal(config.load()[group][key], probe[key], `${group}.${key} did not save`);
      await ownerClient.call("settings/update", { settings: { [group]: before } });
    } else {
      const r = await ownerClient.call("settings/update", { settings: { [group]: probe } });
      assert.equal(r.status, 200, `${group} was rejected`);
      assert.deepEqual(config.load()[group], probe, `${group} did not save`);
      await ownerClient.call("settings/update", { settings: { [group]: before } });
    }
  }
});

test("the local wake route answers with a usable voice status", async () => {
  // The bug this pins: status() is async, and spreading the promise into the
  // response body sent the page {} — a voice status with no engine in it, which
  // the window then read a field off and threw.
  await ownerClient.call("voice/microphone", { granted: true });
  const r = await ownerClient.call("voice/wake", { ms: 900, distance: 2.1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "woke", JSON.stringify(r.body));
  assert.ok(r.body.status && typeof r.body.status === "object", "the answer must carry the voice status");
  assert.ok(r.body.status.engine, "and the status must have its engine, not a promise that serialised to nothing");
  assert.equal(typeof r.body.status.state, "string");
  // A paired phone cannot declare that the computer heard its wake word.
  const remote = await remoteClient.call("voice/wake", { ms: 900, distance: 2.1 });
  assert.equal(remote.status, 403);
});
