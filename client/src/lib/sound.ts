// Local sounds, synthesised in the page with the Web Audio API.
// No audio files, no downloads, nothing fetched from anywhere.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

interface Tone {
  freq: number;
  ms: number;
  gain?: number;
  type?: OscillatorType;
}

function play(tones: Tone[]): void {
  const c = context();
  if (!c) return;
  let at = c.currentTime;
  for (const t of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = t.type ?? "sine";
    osc.frequency.setValueAtTime(t.freq, at);
    const peak = t.gain ?? 0.09;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + t.ms / 1000);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + t.ms / 1000 + 0.02);
    at += t.ms / 1000;
  }
}

/** Played the moment the wake phrase is recognised, before listening starts. */
export function wakeSound(): void {
  play([
    { freq: 660, ms: 90 },
    { freq: 990, ms: 130 },
  ]);
}

/** Played when listening ends, so silence is never ambiguous. */
export function sleepSound(): void {
  play([
    { freq: 620, ms: 90 },
    { freq: 420, ms: 120 },
  ]);
}

/** An urgent customer needs attention. Deliberately unlike the wake sound. */
export function alertSound(): void {
  play([
    { freq: 880, ms: 140, gain: 0.12 },
    { freq: 0.0001, ms: 70, gain: 0.0001 },
    { freq: 880, ms: 140, gain: 0.12 },
    { freq: 0.0001, ms: 70, gain: 0.0001 },
    { freq: 1100, ms: 220, gain: 0.12 },
  ]);
}

export function stopSound(): void {
  play([
    { freq: 300, ms: 200, gain: 0.12, type: "square" },
  ]);
}

/** Browsers block audio until the user interacts; call this from a click. */
export function unlockAudio(): void {
  context();
}
