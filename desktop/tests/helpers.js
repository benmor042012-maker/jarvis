// Test helpers: isolated JARVIS_HOME per test file, a running agent and a
// signing client that speaks protocol v1 exactly like the browser does.
const fs = require("fs");
const os = require("os");
const path = require("path");

let _home = null;
function home_of() { return _home || require("os").tmpdir(); }
function isolate() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  process.env.JARVIS_HOME = home;
  _home = home;
  // A test never runs the real Ollama on the machine it happens to be on: it
  // would take a minute per answer and make the model, not the code, the thing
  // under test. Point the lookup at nothing; a test that wants a stand-in sets
  // this itself afterwards.
  if (!process.env.JARVIS_OLLAMA_BIN) process.env.JARVIS_OLLAMA_BIN = path.join(home, "no-ollama-here", "ollama");
  for (const k of Object.keys(require.cache)) if (k.includes(path.join("desktop", "src"))) delete require.cache[k];
  return home;
}

async function startAgent(opts = {}) {
  const { Agent } = require("../src/core/agent");
  const config = require("../src/core/config");
  config.reset();
  config.update({ server: { port: 0, lanEnabled: false }, ai: { provider: "mock" }, ...(opts.config || {}) });
  const agent = new Agent({ host: opts.host || {} });
  const info = await agent.start({ staticRoot: opts.staticRoot || path.join(home_of(), "no-ui") });
  return { agent, base: `http://127.0.0.1:${info.port}` };
}

function client(base, device) {
  const { sign } = require("../src/core/protocol");
  const { uuid, randomHex } = require("../src/core/util");
  return {
    device,
    async call(name, params = {}, { ttl = 60000, mutate } = {}) {
      const p = "/api/" + name;
      let env = { v: 1, id: uuid(), device_id: device.id, ts: Date.now(), expires: Date.now() + ttl, nonce: randomHex(12), params, session: "test" };
      env = sign(env, device.secret, "POST", p);
      if (mutate) env = mutate(env);
      const res = await fetch(base + p, { method: "POST", body: JSON.stringify(env), headers: { "content-type": "application/json" } });
      const body = await res.json();
      return { status: res.status, body };
    },
  };
}

module.exports = { isolate, startAgent, client };
