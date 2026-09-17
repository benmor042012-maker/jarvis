#!/usr/bin/env node
// Browser end-to-end test: a real Chromium, a real microphone stream, the real
// agent, the real interface. It proves the things unit tests cannot — that the
// page actually records, that a wake phrase actually starts a command, that a
// stop phrase actually stops it, and that an alert actually reaches a second
// device over the local network.
//
// The speech engine is stubbed (scripts/e2e/stub-whisper.mjs) because no free
// engine can be assumed on a build machine. Everything on either side of it is
// the real thing: the page records and uploads, the agent runs the engine,
// parses its output, matches the phrase and plans the command.
//
// Run: npm run e2e     (needs Playwright; skips with a clear message without it)
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { writeFakeAudio } from "./e2e/make-audio.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = { r: "\x1b[0m", g: "\x1b[32m", red: "\x1b[31m", c: "\x1b[36m", dim: "\x1b[2m" };

let playwright;
try {
  playwright = await import("playwright");
} catch {
  try {
    const require = createRequire(join(process.execPath, "..", "..", "lib", "node_modules", "x"));
    playwright = require("playwright");
  } catch {
    console.log(`${C.dim}Playwright is not installed, so the browser test is skipped.`);
    console.log(`Install it with:  npm i -D playwright && npx playwright install chromium${C.r}`);
    process.exit(0);
  }
}
const { chromium } = playwright.chromium ? playwright : playwright.default;

// --- the checks -------------------------------------------------------------
let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`${C.g}✓${C.r} ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`${C.red}✗ ${name}${detail ? ` — ${detail}` : ""}${C.r}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last && typeof last === "string" ? ` (last: ${last})` : ""}`);
}

// --- an isolated agent with a stubbed speech engine -------------------------
const home = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
process.env.JARVIS_HOME = home;
mkdirSync(join(home, "speech"), { recursive: true });
const modelFile = join(home, "speech", "ggml-small.bin");
writeFileSync(modelFile, "stub model");
const sayFile = join(home, "stub-say.txt");
writeFileSync(sayFile, "");
const audioFile = join(home, "fake-mic.wav");
writeFakeAudio(audioFile);

const require = createRequire(pathToFileURL(join(ROOT, "desktop", "package.json")));
const config = require("./src/core/config.js");
const { Agent } = require("./src/core/agent.js");

config.reset();
config.update({
  server: { port: 0, lanEnabled: false },
  ai: { provider: "mock" },
  voice: {
    enabled: true,
    language: "he",
    wakePhrases: ["תתעורר"],
    stopPhrases: ["עצור", "תעצור", "חירום"],
    quietHours: { enabled: false, start: "23:00", end: "07:00" },
    maxListenMs: 20000,
    keepAudio: false,
    whisperPath: join(ROOT, "scripts", "e2e", "stub-whisper.mjs"),
    whisperModel: modelFile,
    speakReplies: false,
  },
  alerts: { enabled: true, scanIntervalMs: 60000, channels: { notification: false, sound: true, speech: false, phone: true }, speakDetails: false, quietHours: { enabled: false, start: "23:00", end: "07:00" } },
  phone: { enabled: true, simulation: false, allowDialer: true },
});

const dist = join(ROOT, "client", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("Build the interface first:  npm run build");
  process.exit(1);
}

const agent = new Agent({ host: {} });
const info = await agent.start({ staticRoot: dist });
const base = `http://127.0.0.1:${info.port}`;
const owner = agent.ownerDevice();
console.log(`${C.c}agent${C.r} ${base}  home ${home}\n`);

const say = (text) => { writeFileSync(sayFile, text); };

// --- the browser ------------------------------------------------------------
const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${audioFile}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});

function creds(device) {
  return JSON.stringify({ id: device.id, secret: device.secret, name: device.name, role: device.role });
}

async function openPage(device) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(`try { localStorage.setItem("jarvis.device.v1", ${JSON.stringify(creds(device))}); } catch {}`);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}

const { page, errors } = await openPage(owner);

try {
  // 1. Voice first: no text box on the main screen until it is asked for.
  await page.waitForSelector(".voice-main", { timeout: 15000 });
  check("the main screen is the voice bar", await page.isVisible(".mic-orb"));
  check("no text box on the main screen", (await page.locator("#command-input").count()) === 0);
  await page.getByRole("button", { name: "Use keyboard instead" }).click();
  check("typing is available when asked for", await page.isVisible("#command-input"));
  await page.getByRole("button", { name: "Hide keyboard" }).click();

  // 2. The permission screen comes before the microphone is ever opened.
  check("the microphone is closed until permission is given", agent.voice.micGranted === false);
  await page.getByRole("button", { name: "Enable microphone" }).click();
  await page.waitForSelector("text=Microphone permission");
  check("the permission screen says the audio stays on this computer", await page.isVisible("text=The audio never leaves this computer."));
  check("the permission screen says raw audio is not saved", await page.isVisible("text=Raw audio is not saved."));
  await page.getByRole("button", { name: /Allow microphone/ }).click();
  await until("the agent to know the microphone is open", () => agent.voice.micGranted === true);
  check("the microphone is open only after allowing it", true);
  await until("the page to show a live microphone", () => page.isVisible(".mic-dot"));
  check("the page shows it is listening", true);

  // 3. A recording actually reaches the agent (this is the whole capture path:
  //    AudioWorklet → voice detector → WAV → upload → local engine).
  const before = agent.voice.stats.utterances;
  await until("a recording to reach the agent", () => agent.voice.stats.utterances > before, 25000);
  check("the page records and uploads what it hears", true);

  // 4. The wake phrase starts listening, with no model involved.
  say("תתעורר");
  await until("the wake phrase", () => agent.voice.stats.wakes >= 1, 25000);
  check("the wake phrase wakes JARVIS", agent.voice.listeningUntil > Date.now());
  await until("the page to show LISTENING", () => page.isVisible("text=LISTENING"));
  check("the interface shows LISTENING", true);

  // 5. A spoken command goes through the normal plan → execute path.
  say("מה השעה");
  const plan = await until("the command to be planned", () => agent.voice.stats.commands >= 1, 25000);
  check("a spoken command is planned and answered", !!plan);
  // The agent counts the command as soon as it starts planning; the page only
  // writes the log line when the upload's answer comes back. Wait for the page.
  await until("the transcript to appear in the log", () => page.isVisible("text=מה השעה"));
  check("the transcript is in the activity log", true);

  // 6. A stop phrase stops everything, without a model.
  say("עצור");
  await until("the stop phrase", () => agent.status().emergency === true, 25000);
  check("a stop phrase stops everything", agent.status().emergency === true);
  check("the stop names what stopped it", /voice/.test(agent.status().emergency_source || ""), String(agent.status().emergency_source));
  check("the page was told which source stopped it", !(await page.isVisible("text=source: unknown")));
  check("stopping needed no model", agent.voice.history.some((h) => h.kind === "stop"));
  await until("the page to show the emergency state", () => page.isVisible("text=EMERGENCY STOPPED"));
  check("the interface shows the emergency state", true);
  agent.clearEmergency({ name: "e2e" });
  await until("the emergency state to clear in the page", async () => !(await page.isVisible("text=EMERGENCY STOPPED")));

  // 7. Quiet hours: heard, understood, and deliberately not acted on.
  const now = new Date();
  const hh = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  config.update({ voice: { quietHours: { enabled: true, start: hh(new Date(now.getTime() - 3600000)), end: hh(new Date(now.getTime() + 3600000)) } } });
  agent.voice.reset("quiet-hours-test");
  const wakesBefore = agent.voice.stats.wakes;
  say("תתעורר");
  await until("the quiet-hours refusal", () => agent.voice.history.some((h) => h.kind === "quiet_hours"), 25000);
  check("quiet hours suppress the wake phrase", agent.voice.stats.wakes === wakesBefore);
  config.update({ voice: { quietHours: { enabled: false, start: "23:00", end: "07:00" } } });

  // 8. Pause really closes the microphone in the page.
  await page.getByRole("button", { name: "Pause microphone" }).click();
  await until("the paused state", async () => await page.isVisible("text=PAUSED"));
  check("pausing is visible and honoured", agent.voice.paused === true);
  await page.getByRole("button", { name: "Resume microphone" }).click();
  await until("listening again", () => agent.voice.paused === false);
  await page.getByRole("button", { name: "Microphone off", exact: true }).click();
  await until("the microphone to close", () => agent.voice.micGranted === false);
  await until("the page to show the microphone closed", () => page.isVisible("text=MICROPHONE OFF"));
  check("the microphone can be closed from the page", true);

  // 9. An urgent customer raises an alert, and it reaches a paired phone on the
  //    same network — over the connection that phone already holds open.
  const phoneDevice = agent.devices.create({ name: "phone-e2e", role: "remote" });
  const phone = await openPage(phoneDevice);
  await phone.page.waitForSelector(".voice-main");
  // The page being drawn is not the same as its event stream being open, and an
  // alert is delivered live with no replay. Ask the agent when the phone is
  // really connected, otherwise the alert can be raised into a closed door.
  await until("the phone's event stream to reach the agent", () => agent.server.connectedRemotes() >= 1, 20000);
  agent.alerts.upsertCustomer({ name: "דנה כהן", phone: "050-123-4567", lastMessage: "זה דחוף, אני מחכה כבר שבוע" });
  await agent.alerts.scan({ force: true });
  await until("the alert on this computer", () => page.isVisible("text=Customer needs attention"));
  check("an urgent customer raises a visible alert", true);
  const alertText = (await page.textContent(".dialog")) || "";
  check("the alert says nothing is sent anywhere", alertText.includes("NO EXTERNAL MESSAGES"), alertText.slice(0, 160));
  await until("the alert on the paired phone", () => phone.page.isVisible("text=Customer needs attention"), 20000);
  check("the paired phone receives the same alert over the local network", true);
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await until("the alert to be acknowledged", () => agent.alerts.list().every((a) => a.status !== "open"));
  check("acknowledging an alert works", true);

  // 10. A call is approved by number, and nothing claims a call happened.
  const call = agent.phone.request({ to: "050-765-4321", reason: "דנה מחכה לתשובה" }, { device: owner, devices: agent.devices.list() });
  await until("the call approval screen", () => page.isVisible("text=Approve this call"));
  // The number on screen is exactly what would be dialled, separators removed.
  check("the approval screen shows the exact number that would be dialled", (await page.textContent(".call-number")) === call.number, await page.textContent(".call-number"));
  const shownStatus = ((await page.textContent(".kv")) || "").toLowerCase();
  check("no screen claims a call connected", !shownStatus.includes("connected"), shownStatus.slice(0, 160));
  await page.getByRole("button", { name: /^Approve/ }).click();
  await until("the call to be approved", () => ["approved", "simulated"].includes(agent.phone.get(call.id).status));
  const after = agent.phone.get(call.id);
  check("approving never places a call by itself", after.outcome === null || after.outcome === "simulated", String(after.outcome));
  check("answering a call is refused with the reason", (() => { try { agent.phone.answerIncoming(); return false; } catch (e) { return e.status === 501; } })());
  await phone.context.close();

  // 10b. A microphone that is open but hears nothing at all says so, and offers
  //      another input. This is the difference between "the wake phrase was
  //      misheard" and "Windows handed over a dead device", which used to look
  //      identical: an empty screen either way. It needs its own browser,
  //      because the fake capture file is chosen per browser, not per page.
  const silentFile = join(home, "silent-mic.wav");
  writeFakeAudio(silentFile, { amplitude: 0 });
  const silentBrowser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${silentFile}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const ctx = await silentBrowser.newContext({ permissions: ["microphone"] });
    await ctx.addInitScript(`try { localStorage.setItem("jarvis.device.v1", ${JSON.stringify(creds(owner))}); } catch {}`);
    const quiet = await ctx.newPage();
    await quiet.goto(base + "/", { waitUntil: "domcontentloaded" });
    await quiet.getByRole("button", { name: "Enable microphone" }).click();
    await quiet.getByRole("button", { name: /Allow microphone/ }).click();
    await until("the silent microphone to be called out", () => quiet.isVisible("text=The microphone is open, but completely silent."), 30000);
    const said = (await quiet.textContent(".banner-warn")) || "";
    check("a silent microphone is reported as a device problem", /device problem/i.test(said), said.slice(0, 200));
    check("and nothing claims it heard a wake phrase", !/heard/i.test(said.replace(/been heard/i, "")), said.slice(0, 200));
    await ctx.close();
  } finally {
    await silentBrowser.close().catch(() => undefined);
  }

  // 11. When the agent goes away the page says so, and never pretends.
  agent.stop();
  await until("the offline state", () => page.isVisible("text=The JARVIS agent is not reachable"), 40000);
  check("an unreachable agent is stated, not hidden", true);

  check("no uncaught errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`${C.red}✗ ${err.message}${C.r}`);
  try { console.log((await page.textContent("body"))?.slice(0, 1500)); } catch { /* the page may be gone */ }
} finally {
  await browser.close().catch(() => undefined);
  try { agent.stop(); } catch { /* already stopped */ }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* leave it */ }
}

console.log(`\n${failures.length === 0 ? C.g : C.red}${passed} passed, ${failures.length} failed${C.r}`);
if (failures.length) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
