// The voice-first interface, checked at the source level: the parts that must
// not exist (a cloud speech service, a push subscription, audio going anywhere
// but this computer) cannot be proven by clicking around, only by looking.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "..", "client");
const SRC = path.join(CLIENT, "src");

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const all = files.map((f) => ({ f, text: fs.readFileSync(f, "utf8") }));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");

test("speech recognition never goes through a browser cloud service", () => {
  // Chrome's Web Speech API streams the microphone to Google's servers. It is
  // free of charge, but it is not local, so it has no place here.
  for (const { f, text } of all) {
    assert.ok(!/webkitSpeechRecognition|\bnew SpeechRecognition\b|SpeechGrammarList/.test(text), `${path.basename(f)} uses the browser's cloud speech recognition`);
  }
});

test("the recording only ever goes to the local agent", () => {
  const api = fs.readFileSync(path.join(SRC, "api.ts"), "utf8");
  assert.match(api, /fetch\(`\/api\/voice\/utterance\?token=/, "the audio is posted to the local agent by relative path");
  for (const { f, text } of all) {
    const code = stripComments(text);
    // Any absolute URL in the client would be a request to something other than
    // the agent that served the page.
    const urls = [...code.matchAll(/["'`](https?:\/\/[^"'`]+)["'`]/g)].map((m) => m[1]);
    assert.deepEqual(urls, [], `${path.basename(f)} contains an absolute URL: ${urls.join(", ")}`);
  }
});

test("speaking uses only voices installed on this computer", () => {
  const speech = fs.readFileSync(path.join(SRC, "lib", "speech.ts"), "utf8");
  assert.match(speech, /v\.localService/, "network voices must be filtered out");
  assert.match(stripComments(speech), /localService\)/);
  // And when there is no local voice, it must say so rather than use a remote one.
  assert.match(speech, /synthesised on a remote server/);
});

test("the primary surface is voice; typing is a deliberate fallback", () => {
  const app = fs.readFileSync(path.join(SRC, "App.tsx"), "utf8");
  assert.match(app, /<VoiceBar \/>/);
  assert.ok(!/<CommandBar \/>/.test(app), "the text box must not be part of the main screen");
  const bar = fs.readFileSync(path.join(SRC, "components", "VoiceBar.tsx"), "utf8");
  assert.match(bar, /\{keyboard && <CommandBar \/>\}/, "typing appears only when it is asked for");
  for (const control of ["Pause microphone", "Mute", "Emergency stop", "Enable microphone"]) {
    assert.ok(bar.includes(control), `the voice bar is missing "${control}"`);
  }
});

test("the microphone permission screen comes before listening", () => {
  const perm = fs.readFileSync(path.join(SRC, "components", "MicPermission.tsx"), "utf8");
  assert.match(perm, /startListening/);
  assert.match(perm, /audio never leaves this computer/i);
  assert.match(perm, /Raw audio is not saved/i);
  const bar = fs.readFileSync(path.join(SRC, "components", "VoiceBar.tsx"), "utf8");
  // The only way the capture starts from the interface is through that screen.
  assert.ok(!/startListening/.test(bar), "the voice bar must not open the microphone behind the permission screen");
  assert.match(bar, /setAsk\(true\)/);
});

test("the phone app is a local page: a manifest and an offline shell, no push service", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(CLIENT, "public", "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "./");
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(CLIENT, "public", icon.src.replace("./", ""))), `missing ${icon.src}`);
  const sw = fs.readFileSync(path.join(CLIENT, "public", "sw.js"), "utf8");
  const code = stripComments(sw);
  for (const forbidden of ["pushManager", "subscribe(", "applicationServerKey", "firebase", "https://"]) {
    assert.ok(!code.includes(forbidden), `the service worker must not contain ${forbidden}`);
  }
  assert.match(code, /url\.pathname\.startsWith\("\/api\/"\)[\s\S]{0,120}return;/, "agent state must never be served from a cache");
});

test("the audio tap cannot reach the network", () => {
  const worklet = fs.readFileSync(path.join(CLIENT, "public", "audio-worklet.js"), "utf8");
  const code = stripComments(worklet);
  for (const forbidden of ["fetch", "XMLHttpRequest", "WebSocket", "http"]) assert.ok(!code.includes(forbidden), `the worklet must not contain ${forbidden}`);
  assert.match(code, /postMessage/);
});
