// Regression tests for the Cloudflare Worker.
//
// The bug these exist to prevent: a Worker deployed without D1 (or without an
// API key) used to throw "Cannot read properties of undefined (reading
// 'prepare')" on every single request, so JARVIS answered nothing at all and
// the web page blamed a "server that doesn't exist".
//
// Run with:  node --test tests/worker.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { hasDB, hasKey, probe } from "../src/env_guard.js";
import { buildMemoryBlock, callAnthropic, extractAndStore, retrieveMemories, touchAccessed } from "../src/memory.js";
import { reminder_cancel, reminder_list, reminder_poll, reminder_set, tickReminders } from "../src/tools/reminders.js";
import { memory_forget, memory_search, memory_write } from "../src/tools/memory_tools.js";
import { latestBriefing, runBriefing } from "../src/briefing.js";
import { isConfigured as googleConfigured, status as googleStatus } from "../src/google.js";

// An env with nothing configured: the worst case a user can deploy.
const BARE = {};
// Key only: the minimum that should give a working assistant.
const KEY_ONLY = { ANTHROPIC_API_KEY: "sk-ant-test" };

test("detects what is and is not configured", () => {
  assert.equal(hasDB(BARE), false);
  assert.equal(hasKey(BARE), false);
  assert.equal(hasKey(KEY_ONLY), true);
  assert.equal(hasDB({ DB: { prepare: () => {} } }), true);
});

test("probe reports status instead of throwing", async () => {
  const p = await probe(BARE);
  assert.equal(p.anthropic_key, false);
  assert.equal(p.d1_bound, false);
  assert.equal(p.d1_works, false);
  assert.equal(p.google_configured, false);
});

test("memory retrieval is empty, not fatal, without D1", async () => {
  const { core, associative } = await retrieveMemories(BARE, "effi", "מה השעה");
  assert.deepEqual(core, []);
  assert.deepEqual(associative, []);
  assert.equal(buildMemoryBlock(core, associative), "");
});

test("memory writes are skipped, not fatal, without D1", async () => {
  await touchAccessed(BARE, [{ id: "a" }]);
  assert.equal(await extractAndStore(BARE, "effi", "היי", "שלום"), null);
  assert.equal(await extractAndStore(KEY_ONLY, "effi", "היי", "שלום"), null);
});

test("callAnthropic reports a missing key instead of sending a request", async () => {
  const r = await callAnthropic(BARE, { model: "x", messages: [] });
  assert.ok(r.error, "expected an error object");
  assert.match(r.error.message, /ANTHROPIC_API_KEY/);
});

test("every reminder entry point answers without D1", async () => {
  assert.match((await reminder_set(BARE, "effi", { text: "x", in_seconds: 60 })).error, /D1/);
  assert.deepEqual((await reminder_list(BARE, "effi")).reminders, []);
  assert.match((await reminder_cancel(BARE, "effi", { id: "1" })).error, /D1/);
  assert.deepEqual((await reminder_poll(BARE, "effi")).fired, []);
  assert.deepEqual(await tickReminders(BARE), { fired: 0 });
});

test("every memory tool answers without D1", async () => {
  assert.match((await memory_write(BARE, "effi", { content: "x" })).error, /D1/);
  assert.deepEqual((await memory_search(BARE, "effi", { query: "x" })).memories, []);
  assert.match((await memory_forget(BARE, "effi", { all: true })).error, /D1/);
});

test("briefing explains what is missing instead of crashing", async () => {
  const noKey = await runBriefing(BARE, "effi", { deliver: false });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /ANTHROPIC_API_KEY/);

  const noDb = await runBriefing(KEY_ONLY, "effi", { deliver: false });
  assert.equal(noDb.ok, false);
  assert.match(noDb.error, /D1/);

  assert.deepEqual(await latestBriefing(BARE, "effi"), { briefing: null, not_configured: "d1" });
});

test("google reports not-configured without credentials or D1", async () => {
  assert.equal(googleConfigured(BARE), false);
  // Credentials without a database to store the refresh token is not usable.
  assert.equal(googleConfigured({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }), false);
  const s = await googleStatus(BARE, "effi");
  assert.equal(s.connected, false);
});

test("a failing D1 binding degrades like a missing one", async () => {
  const brokenDB = {
    DB: {
      prepare() {
        throw new Error("D1_ERROR: no such table");
      },
    },
  };
  const { core } = await retrieveMemories(brokenDB, "effi", "x");
  assert.deepEqual(core, []);
  assert.deepEqual(await latestBriefing(brokenDB, "effi"), { briefing: null });
});
