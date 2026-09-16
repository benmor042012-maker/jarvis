// Remote access over the relay.
//
// Two properties are being proved here, because everything else about remote
// control rests on them:
//   1. The relay is blind. What travels over it is sealed; a relay operator who
//      logs every byte learns neither the command nor the reply.
//   2. The relay is powerless. Frames it forwards go through the same verifier
//      as the local link, so a hostile relay cannot forge, replay, tamper with
//      or privilege-escalate a request.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { isolate, startAgent, client } = require("./helpers");
const home = isolate();

const channel = require("../src/core/channel");
const { RelayClient } = require("../src/core/relay-client");
const { sign } = require("../src/core/protocol");
const { uuid, randomHex } = require("../src/core/util");

let agent, base, owner, remote;

test.before(async () => {
  ({ agent, base } = await startAgent());
  owner = agent.ownerDevice();
  const { code } = agent.devices.createPairCode();
  const res = await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code, name: "phone" }), headers: { "content-type": "application/json" } });
  const body = await res.json();
  remote = { id: body.device_id, secret: body.secret, role: body.role };
});
test.after(() => agent.stop());

// --- the sealed channel -----------------------------------------------------

test("a sealed frame round-trips and carries no readable payload", () => {
  const secret = randomHex(32);
  const frame = channel.seal(secret, "to_agent", { path: "command", body: { command: "open notepad" } }, { deviceId: "dev-1" });
  const wire = JSON.stringify(frame);

  assert.ok(!wire.includes("notepad"), "the command must not appear on the wire");
  assert.ok(!wire.includes("command"), "the path must not appear on the wire");
  assert.ok(!wire.includes(secret), "the secret must never be transmitted");

  const opened = channel.open(secret, "to_agent", frame);
  assert.equal(opened.body.command, "open notepad");
});

test("a frame cannot be opened with the wrong key, direction or contents", () => {
  const secret = randomHex(32);
  const other = randomHex(32);
  const frame = channel.seal(secret, "to_agent", { path: "status" }, { deviceId: "dev-1" });

  assert.throws(() => channel.open(other, "to_agent", frame), /bad decrypt|unable to authenticate/i);
  assert.throws(() => channel.open(secret, "to_device", frame), /wrong direction/);

  // Flip one byte of ciphertext: GCM must refuse it.
  const ct = Buffer.from(frame.ct, "base64");
  ct[0] ^= 0xff;
  assert.throws(() => channel.open(secret, "to_agent", { ...frame, ct: ct.toString("base64") }), /unable to authenticate|bad decrypt/i);

  // The device id is authenticated data, so swapping it invalidates the frame.
  assert.throws(() => channel.open(secret, "to_agent", { ...frame, device_id: "dev-2" }), /unable to authenticate|bad decrypt/i);
});

test("a stale frame is refused even before the protocol replay guard sees it", () => {
  const secret = randomHex(32);
  const realNow = Date.now;
  Date.now = () => realNow() - (channel.MAX_AGE_MS + 5000);
  const old = channel.seal(secret, "to_agent", { path: "status" }, { deviceId: "d" });
  Date.now = realNow;
  assert.throws(() => channel.open(secret, "to_agent", old), /expired/);
});

// --- a fake relay, end to end ----------------------------------------------

// Mirrors relay/worker.js closely enough to exercise the agent's client:
// long-poll for messages, accept replies, match them by id.
function fakeRelay() {
  const queue = [];
  const replies = new Map();
  const seenFrames = [];
  let waiting = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const readBody = () => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

    if (url.pathname.endsWith("/poll")) {
      if (queue.length) return send(200, { messages: queue.splice(0) });
      waiting = send;
      setTimeout(() => { if (waiting === send) { waiting = null; send(200, { messages: [] }); } }, 250);
      return undefined;
    }
    if (url.pathname.endsWith("/reply")) {
      const body = JSON.parse(await readBody());
      replies.get(body.id)?.(body.frame);
      replies.delete(body.id);
      return send(200, { ok: true });
    }
    return send(404, { error: "not_found" });
  });

  return {
    server,
    seenFrames,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => server.close(r)),
    // Acts as the phone: push a sealed frame in and wait for the sealed reply.
    send(frame) {
      const id = uuid();
      seenFrames.push(JSON.stringify(frame));
      const message = { id, frame, at: Date.now() };
      return new Promise((resolve, reject) => {
        replies.set(id, resolve);
        setTimeout(() => { if (replies.delete(id)) reject(new Error("relay timeout")); }, 5000);
        if (waiting) { const w = waiting; waiting = null; w(200, { messages: [message] }); }
        else queue.push(message);
      });
    },
  };
}

// Builds the signed protocol envelope a phone would send, then seals it.
function sealedCall(device, name, params = {}, { mutate, ttl = 60000 } = {}) {
  const path = "/api/" + name;
  let env = { v: 1, id: uuid(), device_id: device.id, ts: Date.now(), expires: Date.now() + ttl, nonce: randomHex(12), params, session: "relay-test" };
  env = sign(env, device.secret, "POST", path);
  if (mutate) env = mutate(env);
  return channel.seal(device.secret, "to_agent", { path: name, body: env }, { deviceId: device.id });
}

async function withRelay(fn) {
  const relay = fakeRelay();
  const url = await relay.listen();
  const config = require("../src/core/config");
  config.update({ relay: { enabled: true, url: "https://placeholder.invalid", room: randomHex(16) } });
  // The config validator insists on https for a real relay; the test server is
  // plain http on loopback, so point the client at it directly.
  const rc = new RelayClient(agent, agent.server);
  rc._base = () => `${url}/r/test`;
  rc.running = true;
  const loop = rc._run();
  try {
    return await fn({ relay, rc });
  } finally {
    rc.running = false;
    await relay.close();
    await loop.catch(() => {});
    config.update({ relay: { enabled: false } });
  }
}

test("a signed command from a paired phone runs, and the reply is sealed", async () => {
  await withRelay(async ({ relay, rc }) => {
    const frame = sealedCall(remote, "status");
    const replyFrame = await relay.send(frame);

    const wire = relay.seenFrames.join("") + JSON.stringify(replyFrame);
    assert.ok(!wire.includes(remote.secret), "the device secret never travels");
    assert.ok(!wire.includes("assistant"), "the reply body is not readable on the wire");

    const reply = channel.open(remote.secret, "to_device", replyFrame);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true);
    assert.equal(typeof reply.body.mode, "string");
    assert.equal(rc.status().connected, true);
  });
});

test("a replayed frame is refused by the protocol guard", async () => {
  await withRelay(async ({ relay }) => {
    const frame = sealedCall(remote, "status");
    const first = channel.open(remote.secret, "to_device", await relay.send(frame));
    assert.equal(first.status, 200);

    // Byte-identical resend: same request id and nonce.
    const second = channel.open(remote.secret, "to_device", await relay.send(frame));
    assert.equal(second.status, 409);
    assert.match(second.body.error, /duplicated|replayed/);
  });
});

test("tampering with parameters after signing is refused", async () => {
  await withRelay(async ({ relay }) => {
    const frame = sealedCall(remote, "settings/update", { settings: { mode: "safe" } }, {
      mutate: (env) => ({ ...env, params: { settings: { mode: "advanced" } } }),
    });
    const reply = channel.open(remote.secret, "to_device", await relay.send(frame));
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error, "modified");
  });
});

test("an expired envelope is refused", async () => {
  await withRelay(async ({ relay }) => {
    const path = "/api/status";
    let env = { v: 1, id: uuid(), device_id: remote.id, ts: Date.now() - 60000, expires: Date.now() - 1000, nonce: randomHex(12), params: {} };
    env = sign(env, remote.secret, "POST", path);
    const frame = channel.seal(remote.secret, "to_agent", { path: "status", body: env }, { deviceId: remote.id });
    const reply = channel.open(remote.secret, "to_device", await relay.send(frame));
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error, "expired");
  });
});

test("owner-only actions are refused over the relay", async () => {
  await withRelay(async ({ relay }) => {
    const frame = sealedCall(remote, "relay/configure", { enabled: false });
    const reply = channel.open(remote.secret, "to_device", await relay.send(frame));
    assert.equal(reply.status, 403);
    assert.equal(reply.body.error, "forbidden");
  });
});

test("a revoked device gets no reply at all", async () => {
  const { code } = agent.devices.createPairCode();
  const res = await fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ code, name: "doomed" }), headers: { "content-type": "application/json" } });
  const doomed = await res.json();
  const victim = { id: doomed.device_id, secret: doomed.secret };
  agent.devices.revoke(victim.id);

  await withRelay(async ({ relay }) => {
    await assert.rejects(relay.send(sealedCall(victim, "status")), /relay timeout/);
  });
});

test("a frame the relay forged with its own key is ignored", async () => {
  await withRelay(async ({ relay }) => {
    const attacker = randomHex(32);
    const forged = channel.seal(attacker, "to_agent", { path: "command", body: { command: "delete everything" } }, { deviceId: remote.id });
    await assert.rejects(relay.send(forged), /relay timeout/);
  });
});

test("remote access is off until it is configured, and misconfiguration is reported", () => {
  const config = require("../src/core/config");
  config.update({ relay: { enabled: false, url: "", room: "" } });
  const rc = new RelayClient(agent, agent.server);
  assert.equal(rc.start().running, false, "must not dial out while disabled");

  assert.throws(() => config.update({ relay: { enabled: true } }), /set the relay address/);
  assert.throws(() => config.update({ relay: { url: "http://relay.example" } }), /https/);
  assert.throws(() => config.update({ relay: { room: "nope" } }), /32 hex/);
});
