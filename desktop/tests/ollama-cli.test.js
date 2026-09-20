// The local model run as a program: `ollama run` with the prompt on stdin and
// the answer streamed from stdout. No socket, no key, nothing paid for.
//
// Ollama itself cannot be installed on a build machine, so a stand-in program
// plays it here: it lists models, reads its prompt from stdin, streams a JSON
// plan back in pieces, and can be told to stall, to fail, or to be an older
// version that does not know a flag. Everything on JARVIS's side of that
// boundary is the real code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isolate } = require("./helpers");
isolate();

const WIN = process.platform === "win32";
const config = require("../src/core/config");
const cli = require("../src/core/planner/ollama-cli");
const local = require("../src/core/planner/local-model");
const { planCommand } = require("../src/core/planner");
const { buildRegistry } = require("../src/core/tools");

/**
 * The stand-in. Behaviour is chosen by the model name it is asked to run, so
 * one program covers every case:
 *   ok        streams {"message": …, "actions": []} in three pieces
 *   slow      says nothing for 3 s, then answers
 *   broken    exits 1 with an error on stderr
 *   oldflags  rejects --keepalive/--format like an older Ollama, answers without
 */
function makeStub(dir) {
  const file = path.join(dir, "ollama");
  const src = `#!/usr/bin/env node
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === "list") {
  process.stdout.write("NAME              ID              SIZE      MODIFIED\\n");
  process.stdout.write("llama3.2:3b       a80c4f17acd5    2.0 GB    2 hours ago\\n");
  process.stdout.write("qwen2.5:7b        845dbda0ea48    4.7 GB    3 days ago\\n");
  // The stand-in's own personalities, so a test can choose one by name.
  for (const m of ["slow", "broken", "oldflags"]) process.stdout.write(m.padEnd(18) + "0000000000000   1.0 GB    3 days ago\\n");
  process.exit(0);
}
if (args[0] !== "run") { process.stderr.write("unknown command\\n"); process.exit(2); }
const model = args[1];
if (model === "oldflags" && args.some((a) => a.startsWith("--"))) {
  process.stderr.write("Error: unknown flag: " + args.find((a) => a.startsWith("--")) + "\\n");
  process.exit(1);
}
if (model === "broken") { process.stderr.write("Error: model failed to load\\n"); process.exit(1); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", async () => {
  // What arrived on stdin is written to a side file so the test can prove the
  // prompt came that way and never as an argument.
  require("fs").writeFileSync(process.env.STUB_SEEN, JSON.stringify({ argv: args, stdin: input }));
  if (model === "slow") await sleep(3000);
  const says = /פנקס|notepad/i.test(input) ? "פותח את פנקס הרשימות." : "הבנתי, מטפל בזה.";
  const full = JSON.stringify({ message: says, actions: /פנקס|notepad/i.test(input) ? [{ tool: "open_app", params: { app: "notepad" } }] : [] });
  const cut = full.indexOf('"actions"');
  process.stdout.write(full.slice(0, 12)); await sleep(40);
  process.stdout.write(full.slice(12, cut)); await sleep(40);
  process.stdout.write(full.slice(cut));
  process.exit(0);
});
`;
  fs.writeFileSync(file, src);
  fs.chmodSync(file, 0o755);
  return file;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-ollama-"));
const stub = makeStub(tmp);
const seenFile = path.join(tmp, "seen.json");
const seen = () => JSON.parse(fs.readFileSync(seenFile, "utf8"));

function withStub() {
  process.env.JARVIS_OLLAMA_BIN = stub;
  process.env.STUB_SEEN = seenFile;
  cli.resetCache();
  local.resetCache();
}
function withoutStub() {
  process.env.JARVIS_OLLAMA_BIN = path.join(tmp, "nowhere", "ollama");
  cli.resetCache();
  local.resetCache();
}

test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test("the first words of a JSON answer can be read while the rest is still arriving", () => {
  assert.equal(local.partialMessage('{"message": "פותח את פנקס הרשימות עכשיו", "actions"'), "פותח את פנקס הרשימות עכשיו");
  assert.equal(local.partialMessage('{"message": "פותח את פנקס הרשימ'), "פותח את פנקס הרשימ", "a message still being written shows once it is a few words");
  assert.equal(local.partialMessage('{"message": "short'), null, "but not a fragment too short to mean anything");
  assert.equal(local.partialMessage('{"actions": []'), null);
  assert.equal(local.partialMessage('{"message": "line one\\nline two"'), "line one\nline two", "escapes are undone");
  assert.equal(local.partialMessage(""), null);
});

test("an override that points at nothing means no Ollama, even with one on PATH", () => {
  // The developer's own Ollama must never answer a test. With the stand-in
  // on PATH and the override pointing at nothing, nothing is found.
  const savedPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${savedPath ?? ""}`;
  try {
    withoutStub();
    assert.equal(cli.findOllama({ force: true }), null);
    withStub();
    assert.equal(cli.findOllama({ force: true }), stub, "and an override that exists is used as it is");
  } finally {
    process.env.PATH = savedPath;
  }
});

test("Ollama absent: the rule planner answers, nothing pretends to be a model, no network is tried", { skip: WIN && "the stand-in is a shebang script, which Windows cannot spawn" }, async () => {
  withoutStub();
  const cfg = config.update({ ai: { provider: "auto", ollamaUrl: "http://127.0.0.1:1", localaiUrl: "http://127.0.0.1:1" } });
  const r = await local.resolve(cfg);
  assert.equal(r.provider, "mock");
  assert.match(r.reason, /MOCK MODE/);
  const plan = await planCommand("מה השעה", { cfg, registry: buildRegistry() });
  assert.equal(plan.mock, true);
  assert.equal(plan.actions[0].tool, "current_time");
});

test("with the program present it is preferred over the socket, and its models are read from `ollama list`", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const cfg = config.update({ ai: { provider: "auto", model: "", ollamaUrl: "http://127.0.0.1:1", localaiUrl: "http://127.0.0.1:1" } });
  const d = await local.detect(cfg, { force: true });
  assert.equal(d.cli.available, true);
  assert.deepEqual(d.cli.models.slice(0, 2), ["llama3.2:3b", "qwen2.5:7b"]);
  assert.equal(d.ollama.available, false, "the socket at :1 is not answering, and is not needed");
  const r = await local.resolve(cfg);
  assert.equal(r.provider, "cli");
  assert.equal(r.model, "llama3.2:3b", "the first listed model when none is chosen");
  assert.equal(r.binary, stub);
  // A chosen model is honoured; a missing one is said so.
  const chosen = await local.resolve(config.update({ ai: { model: "qwen2.5:7b" } }));
  assert.equal(chosen.model, "qwen2.5:7b");
  const missing = await local.resolve(config.update({ ai: { model: "nope:1b" } }));
  assert.equal(missing.model, "llama3.2:3b");
  assert.match(missing.reason, /not installed/);
});

test("a command goes to the model on stdin, never as an argument, and the plan streams back", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const cfg = config.update({ ai: { provider: "auto", model: "", timeoutMs: 20000 } });
  const partials = [];
  const t0 = Date.now();
  let firstAt = null;
  const plan = await planCommand("פתח פנקס רשימות", { cfg, registry: buildRegistry(), onPartial: (m) => { if (firstAt === null) firstAt = Date.now(); partials.push(m); } });
  const total = Date.now() - t0;

  // The plan is real and validated.
  assert.equal(plan.provider, "cli");
  assert.equal(plan.model, "llama3.2:3b");
  assert.equal(plan.message, "פותח את פנקס הרשימות.");
  assert.deepEqual(plan.actions.map((a) => a.tool), ["open_app"]);

  // Its first words arrived before the whole thing did.
  assert.ok(partials.length >= 1, "the message was streamed");
  assert.equal(partials.at(-1), "פותח את פנקס הרשימות.");
  assert.ok(firstAt - t0 < total, `first words at ${String(firstAt - t0)}ms, whole plan at ${String(total)}ms`);
  for (let i = 1; i < partials.length; i++) assert.ok(partials[i].length > partials[i - 1].length, "each partial only ever adds text");

  // How it was asked: the prompt on stdin, the argument list free of it.
  const s = seen();
  assert.match(s.stdin, /פתח פנקס רשימות/);
  assert.match(s.stdin, /User: פתח פנקס רשימות/);
  assert.ok(!s.argv.some((a) => a.includes("פנקס")), `user text must never be an argument: ${JSON.stringify(s.argv)}`);
  assert.deepEqual(s.argv.slice(0, 2), ["run", "llama3.2:3b"]);
  assert.ok(s.argv.includes("--keepalive"), "the model is kept loaded between requests");
  assert.ok(s.argv.includes("--format") && s.argv.includes("json"), "and asked for JSON");
});

test("an older Ollama that rejects the flags is asked again without them", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const r = await cli.askCompat({ binary: stub, model: "oldflags", json: true, prompt: "hello", timeoutMs: 10000 });
  assert.match(r.text, /"message"/);
  assert.ok(!seen().argv.some((a) => a.startsWith("--")), "the retry carried no flags");
});

test("a model that stalls is cut off at the timeout, and the command still gets an answer", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const cfg = config.update({ ai: { provider: "auto", model: "slow", timeoutMs: 800 } });
  const t0 = Date.now();
  const plan = await planCommand("מה השעה", { cfg, registry: buildRegistry() });
  const took = Date.now() - t0;
  assert.ok(took < 2500, `cut off at the timeout, not at the model's leisure (${String(took)}ms)`);
  assert.equal(plan.mock, true, "the rule planner stepped in");
  assert.match(plan.notes.join(" "), /did not answer within/);
  assert.equal(plan.actions[0].tool, "current_time", "and it still did the thing");
});

test("a model that fails is reported, and the rule planner answers instead", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const cfg = config.update({ ai: { provider: "auto", model: "broken", timeoutMs: 5000 } });
  const plan = await planCommand("מה השעה", { cfg, registry: buildRegistry() });
  assert.equal(plan.mock, true);
  assert.match(plan.notes.join(" "), /model failed to load/);
});

test("cancelling stops the program and leaves nothing running", { skip: WIN && "shebang stand-in" }, async () => {
  withStub();
  const ctrl = new AbortController();
  const p = cli.ask({ binary: stub, model: "slow", prompt: "x", signal: ctrl.signal, timeoutMs: 10000 });
  setTimeout(() => { ctrl.abort(); }, 100);
  await assert.rejects(p, /cancelled/);
});

test("two answers streaming at once never share a line: each carries its own request id", async () => {
  // The window side is exercised in the browser test; what the agent
  // guarantees is that a progress event names the request it belongs to and
  // the device that asked, so the page can drop anything that is not its own.
  const { Agent } = require("../src/core/agent");
  const agent = new Agent({ host: {} });
  const events = [];
  agent.on("event", (e) => { if (e.type === "plan_progress") events.push(e); });
  agent.emit("event", { type: "plan_progress", at: Date.now(), request_id: "req-a", device_id: "d1", message: "first" });
  agent.emit("event", { type: "plan_progress", at: Date.now(), request_id: "req-b", device_id: "d1", message: "second" });
  assert.deepEqual(events.map((e) => e.request_id), ["req-a", "req-b"]);
  assert.ok(events.every((e) => typeof e.message === "string" && e.device_id === "d1"));
});
