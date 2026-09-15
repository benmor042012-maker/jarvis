// The Ollama / LocalAI path, exercised against stub servers that speak the
// real protocols. Nobody should discover that this path is broken after
// downloading a 5 GB model, so it is tested here without one.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { isolate } = require("./helpers");
isolate();

const config = require("../src/core/config");
const local = require("../src/core/planner/local-model");
const { planCommand } = require("../src/core/planner");
const { buildRegistry } = require("../src/core/tools");

const registry = buildRegistry();
let ollama, localai, lastOllamaBody, lastLocalAiBody;
let ollamaReply = () => ({ message: { content: JSON.stringify({ message: "פותח פנקס רשימות.", actions: [{ tool: "open_app", params: { app: "notepad" } }] }) } });
let localAiReply = () => ({ choices: [{ message: { content: JSON.stringify({ message: "ok", actions: [{ tool: "current_time", params: {} }] }) } }] });

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function body(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
  });
}

function json(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

test.before(async () => {
  ollama = await listen(async (req, res) => {
    if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "llama3.2:latest" }, { name: "qwen2.5:7b" }] });
    if (req.url === "/api/chat") { lastOllamaBody = await body(req); return json(res, 200, ollamaReply()); }
    json(res, 404, { error: "not found" });
  });
  localai = await listen(async (req, res) => {
    if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "gemma-2b" }] });
    if (req.url === "/v1/chat/completions") { lastLocalAiBody = await body(req); return json(res, 200, localAiReply()); }
    json(res, 404, { error: "not found" });
  });
});
test.after(() => { ollama.close(); localai.close(); });

function cfgWith(extra = {}) {
  config.reset();
  return config.update({
    ai: { provider: "auto", ollamaUrl: `http://127.0.0.1:${ollama.address().port}`, localaiUrl: `http://127.0.0.1:${localai.address().port}`, ...extra },
  });
}

test("detects Ollama and LocalAI and lists their models", async () => {
  const cfg = cfgWith();
  local.resetCache();
  const d = await local.detect(cfg, { force: true });
  assert.equal(d.ollama.available, true);
  assert.deepEqual(d.ollama.models, ["llama3.2:latest", "qwen2.5:7b"]);
  assert.equal(d.localai.available, true);
  assert.deepEqual(d.localai.models, ["gemma-2b"]);
});

test("auto prefers Ollama; an explicit model is honoured, a missing one is reported", async () => {
  local.resetCache();
  let r = await local.resolve(cfgWith());
  assert.equal(r.provider, "ollama");
  assert.equal(r.model, "llama3.2:latest");

  local.resetCache();
  r = await local.resolve(cfgWith({ model: "qwen2.5:7b" }));
  assert.equal(r.model, "qwen2.5:7b");

  local.resetCache();
  r = await local.resolve(cfgWith({ model: "not-installed" }));
  assert.equal(r.model, "llama3.2:latest");
  assert.match(r.reason, /not installed/);

  local.resetCache();
  r = await local.resolve(cfgWith({ provider: "localai" }));
  assert.equal(r.provider, "localai");
  assert.equal(r.model, "gemma-2b");
});

test("a model plan becomes a validated plan, and the prompt carries the tools", async () => {
  const cfg = cfgWith();
  local.resetCache();
  const plan = await planCommand("תפתח לי פנקס רשימות", { cfg, registry });
  assert.equal(plan.provider, "ollama");
  assert.equal(plan.mock, false);
  assert.deepEqual(plan.actions, [{ tool: "open_app", params: { app: "notepad" } }]);
  const sys = lastOllamaBody.messages[0].content;
  assert.match(sys, /open_app/);
  assert.match(sys, /ONE JSON object/);
  assert.equal(lastOllamaBody.format, "json");
  assert.equal(lastOllamaBody.stream, false);
  assert.equal(lastOllamaBody.messages[1].content, "תפתח לי פנקס רשימות");
});

test("LocalAI speaks the OpenAI shape", async () => {
  const cfg = cfgWith({ provider: "localai" });
  local.resetCache();
  const plan = await planCommand("what time is it", { cfg, registry });
  assert.equal(plan.provider, "localai");
  // The schema fills in declared defaults, so the executor always gets complete params.
  assert.deepEqual(plan.actions, [{ tool: "current_time", params: { timezone: "" } }]);
  assert.equal(lastLocalAiBody.response_format.type, "json_object");
});

test("a model that invents a tool or bad parameters has them dropped, not run", async () => {
  const cfg = cfgWith();
  local.resetCache();
  ollamaReply = () => ({ message: { content: JSON.stringify({ message: "sure", actions: [{ tool: "format_c_drive", params: {} }, { tool: "write_file", params: { nope: 1 } }, { tool: "open_app", params: { app: "notepad" } }] }) } });
  const plan = await planCommand("do things", { cfg, registry });
  assert.deepEqual(plan.actions, [{ tool: "open_app", params: { app: "notepad" } }]);
  assert.match(plan.message, /Dropped/);
  assert.match(plan.message, /format_c_drive/);
});

test("prose around the JSON is tolerated; unparseable output falls back to the rule planner", async () => {
  const cfg = cfgWith();
  local.resetCache();
  ollamaReply = () => ({ message: { content: 'Sure!\n```json\n{"message":"ok","actions":[{"tool":"current_time","params":{}}]}\n```' } });
  let plan = await planCommand("time please", { cfg, registry });
  assert.deepEqual(plan.actions, [{ tool: "current_time", params: { timezone: "" } }]);

  local.resetCache();
  ollamaReply = () => ({ message: { content: "I am a chatty model and I forgot the JSON." } });
  plan = await planCommand("open notepad", { cfg, registry });
  assert.equal(plan.mock, true);
  assert.equal(plan.provider, "mock");
  assert.deepEqual(plan.actions, [{ tool: "open_app", params: { app: "notepad" } }]);
  assert.match(plan.notes.join(" "), /Local model failed/);
});

test("a model server that errors falls back instead of breaking the command", async () => {
  const dead = await listen((req, res) => json(res, 500, { error: "boom" }));
  config.reset();
  const cfg = config.update({ ai: { provider: "ollama", ollamaUrl: `http://127.0.0.1:${dead.address().port}` } });
  local.resetCache();
  const plan = await planCommand("what time is it", { cfg, registry });
  assert.equal(plan.mock, true);
  assert.match(plan.notes.join(" "), /not available|HTTP 500/);
  dead.close();
});

test("a cloud endpoint is refused outright, with or without a model", async () => {
  config.reset();
  assert.throws(() => config.update({ ai: { ollamaUrl: "https://api.openai.com/v1" } }), /local network|valid URL/);
  assert.throws(() => config.update({ ai: { localaiUrl: "http://8.8.8.8:11434" } }), /local network/);
});

test("generate() is used for drafts and returns the model's text", async () => {
  const cfg = cfgWith();
  local.resetCache();
  ollamaReply = () => ({ message: { content: "שלום דנה, רציתי לוודא שקיבלת את ההצעה." } });
  const out = await local.generate(cfg, { provider: "ollama", model: "llama3.2:latest" }, "system", "prompt");
  assert.match(out, /שלום דנה/);
});
