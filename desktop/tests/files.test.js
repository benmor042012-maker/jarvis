const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isolate } = require("./helpers");
const home = isolate();
const paths = require("../src/core/paths");
const { resolveApproved } = require("../src/core/tools/files");
const { buildRegistry } = require("../src/core/tools");
const { validateUrl } = require("../src/core/tools/apps");

paths.ensureDirs();
const cfg = { approvedFolders: [paths.WORKSPACE], allowedUrlHosts: ["example.com", "localhost"] };
const reg = buildRegistry();

test("paths outside approved folders, secrets and traversal are refused", () => {
  assert.ok(resolveApproved(cfg, "notes.txt").startsWith(paths.WORKSPACE));
  assert.throws(() => resolveApproved(cfg, "../outside.txt"), /outside the approved/);
  assert.throws(() => resolveApproved(cfg, path.join(home, "config.json")), /blocked|outside/);
  assert.throws(() => resolveApproved(cfg, "sub/.env"), /blocked/);
  assert.throws(() => resolveApproved(cfg, "key.pem"), /blocked/);
  assert.throws(() => resolveApproved(cfg, "~/x"), /Home-relative/);
  assert.throws(() => resolveApproved(cfg, path.join(require("os").tmpdir(), "x.txt")), /outside/);
});

test("symlink escape is refused", () => {
  const link = path.join(paths.WORKSPACE, "escape");
  try { fs.symlinkSync(require("os").tmpdir(), link, "dir"); } catch { return; }
  assert.throws(() => resolveApproved(cfg, "escape/x.txt"), /outside/);
});

test("write/read/search/move/delete/overwrite inside workspace", async () => {
  let r = await reg.run("write_file", { path: "a/b.txt", content: "hello" }, { cfg });
  assert.ok(r.ok, r.summary);
  await assert.rejects(() => reg.run("write_file", { path: "a/b.txt", content: "again" }, { cfg }), /already exists/);
  r = await reg.run("read_file", { path: "a/b.txt" }, { cfg });
  assert.equal(r.data.content, "hello");
  r = await reg.run("search_files", { query: "b.txt" }, { cfg });
  assert.equal(r.data.matches.length, 1);
  r = await reg.run("move_file", { from: "a/b.txt", to: "a/c.txt" }, { cfg });
  assert.ok(r.ok);
  r = await reg.run("overwrite_file", { path: "a/c.txt", content: "new" }, { cfg });
  assert.ok(r.ok && fs.existsSync(r.data.backup));
  r = await reg.run("delete_file", { path: "a/c.txt" }, { cfg });
  assert.ok(r.ok && !fs.existsSync(path.join(paths.WORKSPACE, "a/c.txt")) && fs.existsSync(r.data.trash));
  r = await reg.run("list_trash", {}, { cfg });
  assert.ok(r.data.entries.length >= 2);
});

test("two trash copies of the same name in the same millisecond both survive", async () => {
  // Freeze the clock so both copies really do land on the same timestamp,
  // which on a fast machine is what happens anyway.
  const realIso = Date.prototype.toISOString;
  Date.prototype.toISOString = function frozen() { return "2026-01-01T00:00:00.000Z"; };
  let backup, trashed;
  try {
    let r = await reg.run("write_file", { path: "t/same.txt", content: "first" }, { cfg });
    assert.ok(r.ok, r.summary);
    r = await reg.run("overwrite_file", { path: "t/same.txt", content: "second" }, { cfg });
    backup = r.data.backup;
    r = await reg.run("delete_file", { path: "t/same.txt" }, { cfg });
    trashed = r.data.trash;
  } finally {
    Date.prototype.toISOString = realIso;
  }
  assert.notEqual(backup, trashed);
  assert.equal(fs.readFileSync(backup, "utf8"), "first");
  assert.equal(fs.readFileSync(trashed, "utf8"), "second");
});

test("registry validates params and reports unavailable tools honestly", async () => {
  await assert.rejects(() => reg.run("write_file", { path: "x", content: 5 }, { cfg }), /string/);
  await assert.rejects(() => reg.run("write_file", { path: "x", bogus: 1 }, { cfg }), /unknown field/);
  if (process.platform !== "win32") {
    const r = await reg.run("mouse_click", { x: 1, y: 1 }, { cfg });
    assert.ok(!r.ok && r.data.unavailable && /Windows/.test(r.summary));
  }
  const b = await reg.run("browser_fill_form", { url: "https://example.com", fields: [{ selector: "#a", value: "1" }] }, { cfg });
  assert.ok(!b.ok && /desktop window/.test(b.summary));
});

test("url validation and allowlist", () => {
  assert.equal(validateUrl("example.com/x", cfg), "https://example.com/x");
  assert.throws(() => validateUrl("ftp://example.com", cfg), /http/);
  assert.throws(() => validateUrl("https://user:pw@example.com", cfg), /credentials/);
  assert.throws(() => validateUrl("https://evil.com", cfg), /allowed sites/);
  assert.equal(validateUrl("https://evil.com", { allowedUrlHosts: ["*"] }), "https://evil.com/");
});

test("timeout and cancellation in registry.run", async () => {
  reg.register({ name: "t_slow", description: "x", schema: { type: "object", properties: {} }, risk: "low", timeoutMs: 50, run: () => new Promise(() => {}) });
  await assert.rejects(() => reg.run("t_slow", {}, { cfg }), /timed out/);
  reg.register({ name: "t_cancel", description: "x", schema: { type: "object", properties: {} }, risk: "low", timeoutMs: 5000, run: (_p, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("cancelled")))) });
  const ctrl = new AbortController();
  const p = reg.run("t_cancel", {}, { cfg, signal: ctrl.signal });
  ctrl.abort();
  const r = await p;
  assert.equal(r.summary, "cancelled");
});

test("deterministic tools: time, calc, memory, reminders, drafts", async () => {
  assert.ok((await reg.run("current_time", {}, { cfg })).ok);
  assert.equal((await reg.run("calculate", { expression: "2+3*4" }, { cfg })).data.value, 14);
  await assert.rejects(() => reg.run("calculate", { expression: "process.exit()" }, { cfg }));
  await reg.run("remember", { text: "the wifi password box is blue" }, { cfg });
  assert.equal((await reg.run("recall", { query: "wifi" }, { cfg })).data.notes.length, 1);
  const rem = await reg.run("set_reminder", { text: "x", in_minutes: 1 }, { cfg });
  assert.ok(rem.ok);
  assert.equal((await reg.run("list_reminders", {}, { cfg })).data.reminders.length, 1);
  const e = await reg.run("create_email_draft", { to: "a@b.c", subject: "s", body: "hi" }, { cfg });
  assert.ok(e.ok && fs.readFileSync(e.data.path, "utf8").includes("X-Unsent: 1"));
  const c = await reg.run("create_calendar_draft", { title: "t", start_iso: "2030-01-01T10:00:00Z" }, { cfg });
  assert.ok(c.ok && fs.readFileSync(c.data.path, "utf8").includes("BEGIN:VEVENT"));
});

test("the JARVIS home is stored in one canonical spelling", () => {
  // Windows exposes the same folder as a short (RUNNER~1) and a long name.
  // Everything that compares paths must agree, so the constants are canonical.
  const fsMod = require("fs");
  assert.equal(paths.HOME, fsMod.realpathSync.native(paths.HOME));
  assert.equal(paths.WORKSPACE, fsMod.realpathSync.native(paths.WORKSPACE));
  assert.ok(resolveApproved(cfg, "notes.txt").startsWith(paths.WORKSPACE));
  // A folder added through canonicalDir matches what resolveApproved returns.
  const added = paths.canonicalDir(path.join(paths.HOME, "extra"));
  const resolved = resolveApproved({ approvedFolders: [added] }, path.join(added, "x.txt"));
  assert.ok(resolved.startsWith(added), `${resolved} should start with ${added}`);
});
