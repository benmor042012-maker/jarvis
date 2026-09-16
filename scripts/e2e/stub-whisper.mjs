#!/usr/bin/env node
// A stand-in for whisper.cpp, used only by the browser end-to-end test.
//
// It never looks at the audio. It returns whatever the test put in
// stub-say.txt and then empties that file, so each scripted phrase is heard
// exactly once and any extra recording the microphone produces transcribes to
// nothing — which is what a real engine does with silence.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("usage: stub-whisper -m model -f file.wav -of out");
  process.exit(0);
}
const of = args[args.indexOf("-of") + 1];
const home = process.env.JARVIS_HOME || ".";
const script = join(home, "stub-say.txt");

let text = "";
try {
  text = readFileSync(script, "utf8").trim();
  writeFileSync(script, "");
} catch {
  text = "";
}
writeFileSync(`${of}.txt`, text ? `${text}\n` : "\n");
