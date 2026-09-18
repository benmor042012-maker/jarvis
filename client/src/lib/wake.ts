// Local wake-word detection, in the page, in milliseconds.
//
// Running every sound through whisper.cpp to find out whether it was the wake
// phrase is the wrong tool for the job: a full transcription of one word costs
// seconds on an ordinary computer, and a wake phrase answered five seconds
// later is indistinguishable from one that was ignored. This does what a wake
// word actually needs — compares the shape of the sound against recordings of
// the person saying it, and nothing else.
//
// The method is the classic one: MFCC features, then dynamic time warping
// against the enrolled examples. No model, no training, no download, no
// network — a few hundred numbers and about a millisecond of arithmetic per
// check. It answers "was that the phrase" and nothing more; the words of a
// command still go to the speech engine, where accuracy is what matters.

import { TARGET_RATE } from "./wav";

const FRAME = 400; // 25 ms at 16 kHz
const HOP = 160; // 10 ms
const FFT_SIZE = 512;
const MEL_BANDS = 26;
const CEPSTRA = 13;
const PRE_EMPHASIS = 0.97;

/** The longest a wake phrase may be, in seconds. */
export const MAX_WAKE_SECONDS = 2.0;

// --- MFCC ---------------------------------------------------------------------

const hamming = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filters over the FFT bins, built once. */
const filters: { start: number; weights: Float32Array }[] = (() => {
  const bins = FFT_SIZE / 2 + 1;
  const low = hzToMel(80);
  const high = hzToMel(TARGET_RATE / 2);
  const points: number[] = [];
  for (let i = 0; i < MEL_BANDS + 2; i++) {
    const hz = melToHz(low + ((high - low) * i) / (MEL_BANDS + 1));
    points.push(Math.floor(((FFT_SIZE + 1) * hz) / TARGET_RATE));
  }
  const out: { start: number; weights: Float32Array }[] = [];
  for (let m = 1; m <= MEL_BANDS; m++) {
    const a = points[m - 1] ?? 0;
    const b = points[m] ?? 0;
    const c = Math.min(points[m + 1] ?? bins - 1, bins - 1);
    const weights = new Float32Array(Math.max(0, c - a + 1));
    for (let k = a; k <= c; k++) {
      const w = k < b ? (b === a ? 1 : (k - a) / (b - a)) : c === b ? 1 : (c - k) / (c - b);
      weights[k - a] = Math.max(0, w);
    }
    out.push({ start: a, weights });
  }
  return out;
})();

/** In-place radix-2 FFT. Real and imaginary parts are separate arrays. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k] as number;
        const uIm = im[i + k] as number;
        const vRe = (re[i + k + len / 2] as number) * curRe - (im[i + k + len / 2] as number) * curIm;
        const vIm = (re[i + k + len / 2] as number) * curIm + (im[i + k + len / 2] as number) * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

const dctTable: Float32Array[] = Array.from({ length: CEPSTRA }, (_, k) => {
  const row = new Float32Array(MEL_BANDS);
  for (let m = 0; m < MEL_BANDS; m++) row[m] = Math.cos((Math.PI * k * (m + 0.5)) / MEL_BANDS);
  return row;
});

/**
 * MFCC frames for a stretch of 16 kHz mono audio, with the average of each
 * coefficient removed. Subtracting the mean is what makes this survive a
 * different microphone, a different room and a different distance from it.
 */
export function features(samples: Float32Array): Float32Array[] {
  const frames: Float32Array[] = [];
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    re.fill(0);
    im.fill(0);
    let prev = samples[start] ?? 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[start + i] ?? 0;
      re[i] = (s - PRE_EMPHASIS * prev) * (hamming[i] as number);
      prev = s;
    }
    fft(re, im);
    const power = new Float32Array(FFT_SIZE / 2 + 1);
    for (let k = 0; k < power.length; k++) {
      const a = re[k] as number;
      const b = im[k] as number;
      power[k] = (a * a + b * b) / FFT_SIZE;
    }
    const energies = new Float32Array(MEL_BANDS);
    for (let m = 0; m < MEL_BANDS; m++) {
      const f = filters[m] as { start: number; weights: Float32Array };
      let sum = 0;
      for (let k = 0; k < f.weights.length; k++) sum += (power[f.start + k] ?? 0) * (f.weights[k] as number);
      energies[m] = Math.log(sum + 1e-10);
    }
    const cep = new Float32Array(CEPSTRA);
    for (let k = 0; k < CEPSTRA; k++) {
      const row = dctTable[k] as Float32Array;
      let sum = 0;
      for (let m = 0; m < MEL_BANDS; m++) sum += (energies[m] as number) * (row[m] as number);
      cep[k] = sum;
    }
    frames.push(cep);
  }
  // Cepstral mean normalisation.
  if (frames.length) {
    const mean = new Float32Array(CEPSTRA);
    for (const f of frames) for (let k = 0; k < CEPSTRA; k++) mean[k] = (mean[k] as number) + (f[k] as number);
    for (let k = 0; k < CEPSTRA; k++) mean[k] = (mean[k] as number) / frames.length;
    for (const f of frames) for (let k = 0; k < CEPSTRA; k++) f[k] = (f[k] as number) - (mean[k] as number);
  }
  return frames;
}

// --- matching -----------------------------------------------------------------

function frameDistance(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let k = 0; k < CEPSTRA; k++) {
    const d = (a[k] as number) - (b[k] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Dynamic time warping: how far one sequence of frames is from another when
 * either may be spoken faster or slower. The result is per frame, so phrases of
 * different lengths are comparable.
 */
export function dtw(a: Float32Array[], b: Float32Array[]): number {
  if (!a.length || !b.length) return Infinity;
  const n = a.length;
  const m = b.length;
  // A band around the diagonal: a wake phrase said at half or double speed is
  // a different phrase, and the band keeps this linear rather than quadratic.
  const band = Math.max(12, Math.floor(Math.max(n, m) * 0.34));
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const from = Math.max(1, i - band);
    const to = Math.min(m, i + band);
    for (let j = from; j <= to; j++) {
      const cost = frameDistance(a[i - 1] as Float32Array, b[j - 1] as Float32Array);
      const best = Math.min(prev[j] as number, cur[j - 1] as number, prev[j - 1] as number);
      cur[j] = cost + best;
    }
    [prev, cur] = [cur, prev];
  }
  const total = prev[m] as number;
  return total / (n + m);
}

export interface WakeModel {
  /** One entry per enrolled recording: its MFCC frames, flattened for storage. */
  templates: number[][];
  /** Frames per template, so the flat arrays can be read back. */
  lengths: number[];
  /** The distance below which a sound counts as the phrase. */
  threshold: number;
  /** When it was taught, so the panel can say. */
  at: number;
}

const flatten = (frames: Float32Array[]): number[] => frames.flatMap((f) => Array.from(f));
const unflatten = (flat: number[], count: number): Float32Array[] =>
  Array.from({ length: count }, (_, i) => Float32Array.from(flat.slice(i * CEPSTRA, (i + 1) * CEPSTRA)));

/**
 * Build a detector from recordings of the phrase.
 *
 * The threshold is derived from the recordings themselves: how far the same
 * person saying the same word twice already is, plus a margin. Somebody with a
 * consistent voice gets a tight detector, somebody who says it differently
 * every time gets a looser one, and neither has to know what a threshold is.
 */
export function enroll(recordings: Float32Array[]): WakeModel | null {
  const sets = recordings.map((r) => features(r)).filter((f) => f.length >= 20);
  if (sets.length < 2) return null;
  let worst = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      worst = Math.max(worst, dtw(sets[i] as Float32Array[], sets[j] as Float32Array[]));
    }
  }
  // Never wider than this, whatever the recordings say: past it, unrelated
  // speech starts to match and JARVIS wakes at the television.
  const threshold = Math.min(worst * 1.35 + 0.4, 9);
  return {
    templates: sets.map(flatten),
    lengths: sets.map((s) => s.length),
    threshold,
    at: Date.now(),
  };
}

export class WakeDetector {
  private templates: Float32Array[][];
  readonly threshold: number;

  constructor(model: WakeModel) {
    this.templates = model.templates.map((flat, i) => unflatten(flat, model.lengths[i] ?? 0));
    this.threshold = model.threshold;
  }

  /** The closest enrolled recording to this audio, and whether that counts. */
  test(samples: Float32Array): { distance: number; hit: boolean } {
    const frames = features(samples);
    if (frames.length < 20) return { distance: Infinity, hit: false };
    let best = Infinity;
    for (const t of this.templates) best = Math.min(best, dtw(frames, t));
    return { distance: best, hit: best <= this.threshold };
  }
}

const KEY = "jarvis.wake.model.v1";

export function loadWakeModel(): WakeModel | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const model = JSON.parse(raw) as WakeModel;
    return Array.isArray(model.templates) && model.templates.length ? model : null;
  } catch {
    return null;
  }
}

export function saveWakeModel(model: WakeModel | null): void {
  try {
    if (model) window.localStorage.setItem(KEY, JSON.stringify(model));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the detector still works until the window is closed */
  }
}
