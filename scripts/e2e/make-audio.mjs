// Builds the WAV that Chromium's fake microphone plays on a loop: a burst of
// tone (loud enough for the voice detector to treat it as speech) followed by
// silence (long enough to end the utterance). Each loop therefore produces
// exactly one recording, which the stub engine turns into the next scripted
// phrase.
import { writeFileSync } from "node:fs";

const RATE = 16000;

export function writeFakeAudio(file, { toneMs = 1200, silenceMs = 1800, freq = 440, amplitude = 0.35 } = {}) {
  const total = Math.round(((toneMs + silenceMs) / 1000) * RATE);
  const toneSamples = Math.round((toneMs / 1000) * RATE);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + total * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i++) {
    // A wobbling tone rather than a pure one: noise suppression is quicker to
    // treat a steady sine as machine hum and mute it.
    const wobble = 1 + 0.3 * Math.sin((2 * Math.PI * 7 * i) / RATE);
    const v = i < toneSamples ? Math.sin((2 * Math.PI * freq * wobble * i) / RATE) * amplitude : 0;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  writeFileSync(file, buf);
  return file;
}
