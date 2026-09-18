// Microphone capture with a local, energy-based voice-activity detector.
//
// Everything here happens in the page: the audio is cut into utterances, turned
// into 16 kHz mono WAV and handed to the local agent, which transcribes it with
// a local engine. No audio is uploaded anywhere else and none is kept on disk
// unless "keep audio" is explicitly switched on in Settings.

import { concat, downsample, encodeWav, rms, TARGET_RATE } from "./wav";

export interface MicSupport {
  supported: boolean;
  reason: string | null;
  fix: string | null;
}

/**
 * Browsers only expose a microphone to a "secure context": https, or a page
 * served from localhost. The JARVIS page on the computer itself is
 * http://127.0.0.1 and qualifies; the same page opened on a phone over the
 * local Wi-Fi (http://192.168.x.x) does not, and the browser hides
 * navigator.mediaDevices entirely. That is a browser rule, not a setting we
 * can flip, so we say so instead of showing a button that cannot work.
 */
export function micSupport(): MicSupport {
  if (typeof window === "undefined") return { supported: false, reason: "No browser environment.", fix: null };
  const secure = window.isSecureContext;
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (!md || typeof md.getUserMedia !== "function") {
    return secure
      ? { supported: false, reason: "This browser does not provide navigator.mediaDevices.getUserMedia, so no page can open a microphone here.", fix: "Open http://127.0.0.1:8765 in Chrome or Edge on the JARVIS computer." }
      : {
          supported: false,
          reason: `This page is not a secure context (${window.location.protocol}//${window.location.hostname}). Browsers only allow microphone access over https or from localhost, so the microphone is blocked before JARVIS is even asked.`,
          fix: "Talk to JARVIS from the computer itself (http://127.0.0.1:8765). The phone can still receive alerts, approve calls and open the dialer — none of those need a microphone.",
        };
  }
  if (typeof AudioContext === "undefined" && typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === "undefined") {
    return { supported: false, reason: "This browser has no Web Audio API, so the recording cannot be converted to the WAV the local speech engine reads.", fix: "Use Chrome or Edge." };
  }
  if (typeof AudioWorkletNode === "undefined") {
    return { supported: false, reason: "This browser has no AudioWorklet, which is how JARVIS reads the microphone without blocking the page.", fix: "Use a current version of Chrome, Edge or Firefox." };
  }
  return { supported: true, reason: null, fix: null };
}

export interface MicOptions {
  /** Longest single utterance. Anything still running at this point is cut and sent. */
  maxSegmentMs: number;
  /** Silence that ends an utterance. */
  silenceMs: number;
  /** Shortest utterance worth transcribing. */
  minSpeechMs: number;
  onSegment: (wav: Blob, durationMs: number, samples: Float32Array) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  /**
   * The microphone opened, stayed open, and never heard anything at all. That
   * is not the same as "no wake phrase": it means Windows handed over a device
   * that delivers silence — a disconnected jack, a muted input, or simply the
   * wrong one of several. Reported once per open, with the device's own name.
   */
  onSilent?: (deviceLabel: string) => void;
  /** Which input to open. Empty means whatever Windows considers default. */
  deviceId?: string | null;
}

const PREROLL_MS = 500;
// How long an open microphone may deliver nothing but digital silence before it
// is called out. Long enough that a quiet room does not trip it.
const SILENT_AFTER_MS = 9000;
const SILENT_PEAK = 0.008;
const FLOOR_FLOOR = 0.006; // below this everything is room tone
const SPEECH_FACTOR = 2.6; // how far above the measured noise floor counts as speech

export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;
  private segment: Float32Array[] = [];
  private segmentSamples = 0;
  private silenceSamples = 0;
  private speaking = false;
  private floor = 0.01;
  private opts: MicOptions;
  private openedAt = 0;
  private peak = 0;
  private silentReported = false;
  private deviceLabel = "";
  running = false;

  constructor(opts: MicOptions) {
    this.opts = opts;
  }

  update(opts: Partial<MicOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Resolves once the microphone is open. Throws a human sentence if it is not. */
  async start(): Promise<void> {
    if (this.running) return;
    const support = micSupport();
    if (!support.supported) throw new Error(support.reason ?? "The microphone is not available in this browser.");
    let stream: MediaStream;
    try {
      const audio: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      // An explicit choice is exact: silently falling back to the device that
      // was not working is how "I picked the other microphone" goes nowhere.
      if (this.opts.deviceId) audio.deviceId = { exact: this.opts.deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      throw new Error(describeMicError(err));
    }
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new Ctor();
    if (ctx.state === "suspended") await ctx.resume();
    try {
      // Same-origin file served by the JARVIS agent itself, so it loads with no
      // network access and passes the page's own content-security-policy.
      await ctx.audioWorklet.addModule(new URL("audio-worklet.js", document.baseURI).href);
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      await ctx.close().catch(() => undefined);
      throw new Error(`The microphone reader could not be loaded: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "jarvis-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this.feed(e.data, ctx.sampleRate);
    };
    source.connect(node);
    this.stream = stream;
    this.ctx = ctx;
    this.source = source;
    this.node = node;
    this.openedAt = Date.now();
    this.peak = 0;
    this.silentReported = false;
    this.deviceLabel = stream.getAudioTracks()[0]?.label ?? "";
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.speaking = false;
    this.segment = [];
    this.segmentSamples = 0;
    this.preroll = [];
    this.prerollSamples = 0;
    if (this.node) this.node.port.onmessage = null;
    try {
      this.node?.disconnect();
      this.source?.disconnect();
    } catch {
      /* already torn down */
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close().catch(() => undefined);
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.opts.onLevel?.(0);
  }

  /** Throw away whatever is being recorded right now (used by Emergency Stop). */
  discard(): void {
    this.speaking = false;
    this.segment = [];
    this.segmentSamples = 0;
    this.silenceSamples = 0;
  }

  private feed(input: Float32Array, rate: number): void {
    if (!this.running) return;
    const chunk = downsample(input, rate);
    const level = rms(chunk);
    this.opts.onLevel?.(Math.min(1, level * 12));
    if (level > this.peak) this.peak = level;
    if (!this.silentReported && this.peak < SILENT_PEAK && Date.now() - this.openedAt > SILENT_AFTER_MS) {
      this.silentReported = true;
      this.opts.onSilent?.(this.deviceLabel);
    }
    // Track the quietest recent level as the room's noise floor so a noisy room
    // raises the bar instead of triggering on everything.
    this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 0.995 + level * 0.005;
    const threshold = Math.max(FLOOR_FLOOR, this.floor * SPEECH_FACTOR);
    const samplesPerMs = TARGET_RATE / 1000;

    if (!this.speaking) {
      this.preroll.push(chunk);
      this.prerollSamples += chunk.length;
      while (this.prerollSamples > PREROLL_MS * samplesPerMs && this.preroll.length > 1) {
        const dropped = this.preroll.shift();
        this.prerollSamples -= dropped?.length ?? 0;
      }
      if (level > threshold) {
        this.speaking = true;
        this.segment = [...this.preroll];
        this.segmentSamples = this.prerollSamples;
        this.silenceSamples = 0;
        this.preroll = [];
        this.prerollSamples = 0;
      }
      return;
    }

    this.segment.push(chunk);
    this.segmentSamples += chunk.length;
    this.silenceSamples = level > threshold ? 0 : this.silenceSamples + chunk.length;
    const silenceDone = this.silenceSamples >= this.opts.silenceMs * samplesPerMs;
    const tooLong = this.segmentSamples >= this.opts.maxSegmentMs * samplesPerMs;
    if (silenceDone || tooLong) this.flush();
  }

  private flush(): void {
    const samples = concat(this.segment);
    this.speaking = false;
    this.segment = [];
    this.segmentSamples = 0;
    this.silenceSamples = 0;
    const durationMs = (samples.length / TARGET_RATE) * 1000;
    if (durationMs < this.opts.minSpeechMs) return;
    try {
      this.opts.onSegment(encodeWav(samples), durationMs, samples);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : "The recording could not be prepared.");
    }
  }
}

export function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone permission was refused. JARVIS cannot listen until the browser (or Windows privacy settings) allows the microphone for this page.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found on this computer. Plug one in, then try again.";
    case "NotReadableError":
      return "The microphone is in use by another program and Windows will not share it. Close the other program and try again.";
    case "AbortError":
      return "The microphone was closed before it could start.";
    default:
      return err instanceof Error && err.message ? `The microphone could not be opened: ${err.message}` : "The microphone could not be opened.";
  }
}
