const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isolate, startAgent, client } = require("./helpers");
const home = isolate();

let agent, base, owner, c;
test.before(async () => { ({ agent, base } = await startAgent()); owner = agent.ownerDevice(); c = client(base, owner); });
test.after(() => agent.stop());

async function waitTask(id) {
  let t;
  for (let i = 0; i < 600; i++) {
    t = (await c.call("projects/get", { task_id: id })).body.task;
    if (!["running", "cancelling", "planned"].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  return t;
}

test("templates are listed", async () => {
  const r = await c.call("projects/templates");
  assert.deepEqual(r.body.templates.map((t) => t.id).sort(), ["api", "desktop", "installer", "mobile", "website"]);
});

test("website project: plan shows everything, run needs the hash, tests pass, scan clean, preview served", async () => {
  const p = await c.call("projects/plan", { name: "My Site", template: "website", description: "A bakery site" });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const task = p.body.task;
  assert.equal(task.mock, true);
  assert.ok(task.files.length >= 5);
  assert.ok(task.commands.some((x) => x.step === "test"));
  assert.equal(task.publish.startsWith("disabled"), true);
  const bad = await c.call("projects/run", { task_id: task.task_id, hash: "nope" });
  assert.equal(bad.body.error, "modified");
  const run = await c.call("projects/run", { task_id: task.task_id, hash: task.hash });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const done = await waitTask(task.task_id);
  assert.equal(done.status, "completed", JSON.stringify(done.progress.slice(-3)));
  assert.ok(fs.existsSync(path.join(home, "projects", "my-site", "index.html")));
  assert.equal(done.scan.secrets.length, 0);
  assert.ok(done.changed_files.includes("index.html"));
  assert.ok(done.preview && done.preview.url);
  const tok = await c.call("preview/token");
  const html = await fetch(base + done.preview.url + "?token=" + tok.body.token);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /my-site/);
  const noTok = await fetch(base + done.preview.url);
  assert.equal(noTok.status, 401);
  const dup = await c.call("projects/plan", { name: "my-site", template: "website" });
  assert.equal(dup.status, 400);
  assert.match(dup.body.detail, /already exists/);
});

test("api project runs its own tests", async () => {
  const p = await c.call("projects/plan", { name: "svc", template: "api", run_build: false });
  const run = await c.call("projects/run", { task_id: p.body.task.task_id, hash: p.body.task.hash });
  assert.equal(run.status, 200);
  const done = await waitTask(p.body.task.task_id);
  assert.equal(done.status, "completed", JSON.stringify(done.progress.slice(-2)));
});

test("offline mode skips network installs instead of failing silently", async () => {
  await c.call("settings/update", { settings: { offlineMode: true } });
  const p = await c.call("projects/plan", { name: "deskapp", template: "desktop" });
  assert.ok(p.body.task.commands.find((x) => x.step === "install").offline_blocked);
  const run = await c.call("projects/run", { task_id: p.body.task.task_id, hash: p.body.task.hash });
  assert.equal(run.status, 200);
  const done = await waitTask(p.body.task.task_id);
  assert.ok(done.progress.some((e) => /skipped install: offline mode/.test(e.text)));
  assert.equal(done.status, "completed", JSON.stringify(done.progress.slice(-2)));
  await c.call("settings/update", { settings: { offlineMode: false } });
});

test("secret scan blocks generated secrets", () => {
  const { scanProject } = require("../src/core/projects");
  const dir = path.join(home, "projects", "scan-me");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.js"), 'const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";');
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "event-stream": "3.3.6" } }));
  const s = scanProject(dir);
  assert.equal(s.secrets.length, 1);
  assert.deepEqual(s.dangerous, ["event-stream@3.3.6"]);
});

test("cancellation stops a running project task", async () => {
  const p = await c.call("projects/plan", { name: "slow", template: "api" });
  const task = agent.projects.tasks.get(p.body.task.task_id);
  task.commands = [{ step: "test", argv: ["node", "-e", "setTimeout(()=>{}, 20000)"], needs_network: false }];
  task.hash = require("../src/core/util").paramsHash({ name: task.name, template: task.template, description: task.description, commands: task.commands, files: task.files });
  await c.call("projects/run", { task_id: task.task_id, hash: task.hash });
  await new Promise((r) => setTimeout(r, 300));
  await c.call("projects/cancel", { task_id: task.task_id });
  const done = await waitTask(task.task_id);
  assert.equal(done.status, "cancelled");
});
