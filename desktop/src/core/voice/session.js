// The voice session: standby → wake → listening → thinking → speaking → standby.
//
// The microphone is captured by the JARVIS window (or a paired phone) and the
// audio is transcribed here, on this computer, by a local engine. Nothing is
// uploaded; recordings are deleted immediately after transcription unless the
// user explicitly turns on keepAudio.
const EventEmitter = require("events");

const audit = require("../audit");
const stt = require("./stt");
const { matchAny, normalize, stripPhrase, words } = require("./phrases");

const STATES = ["unavailable", "permission_required", "off", "standby", "listening", "thinking", "speaking", "paused", "muted", "quiet_hours"];

// A wake utterance is short by nature. Anything long that merely happens to
// contain the phrase is treated as ordinary speech, not a wake.
const MAX_WAKE_WORDS = 6;
const MIN_WAKE_MS = 200;
const WAKE_COOLDOWN_MS = 1500;

function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Quiet hours may wrap past midnight (22:00 → 07:00). */
function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.enabled) return false;
  const start = hhmmToMinutes(quiet.start);
  const end = hhmmToMinutes(quiet.end);
  if (start === null || end === null || start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

class VoiceSession extends EventEmitter {
  constructor({ getConfig, onCommand, onStop, host = {} }) {
    super();
    this.getConfig = getConfig;
    this.onCommand = onCommand; // (text, meta) -> Promise<{ plan, job }>
    this.onStop = onStop; // (source) -> void   emergency stop, no model involved
    this.host = host;
    this.state = "off";
    this.micGranted = false;
    this.paused = false;
    this.muted = false;
    this.lastWakeAt = 0;
    this.listeningUntil = 0;
    this.lastHeard = null;
    this.lastError = null;
    this.stats = { wakes: 0, falseWakes: 0, commands: 0, stops: 0, utterances: 0 };
    this.history = [];
  }

  cfg() {
    return this.getConfig().voice || {};
  }

  _set(state, reason) {
    if (!STATES.includes(state)) return;
    if (this.state === state) return;
    this.state = state;
    this.emit("change", { state, reason: reason || null });
  }

  _remember(entry) {
    // Transcripts only, never audio. Capped, and wiped by "delete local data".
    this.history.push({ at: Date.now(), ...entry });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
  }

  /** What the UI shows, and why it cannot listen when it cannot. */
  async status({ force = false } = {}) {
    const cfg = this.getConfig();
    const v = cfg.voice || {};
    const engine = await stt.detect(cfg, { force });
    const quiet = inQuietHours(v.quietHours);
    let state = this.state;
    if (!v.enabled) state = "off";
    else if (!engine.available) state = "unavailable";
    else if (!this.micGranted) state = "permission_required";
    else if (this.muted) state = "muted";
    else if (this.paused) state = "paused";
    else if (quiet) state = "quiet_hours";
    else if (!["listening", "thinking", "speaking"].includes(state)) state = "standby";
    this.state = state;
    return {
      state,
      enabled: !!v.enabled,
      engine: {
        available: engine.available,
        name: engine.engine,
        model: engine.model ? require("path").basename(engine.model) : null,
        hebrew: engine.hebrew,
        reason: engine.reason,
        install: engine.install,
        checked: engine.checked,
      },
      microphone: { granted: this.micGranted, required: true },
      wakePhrases: v.wakePhrases || [],
      stopPhrases: v.stopPhrases || [],
      quietHours: { ...(v.quietHours || {}), active: quiet },
      maxListenMs: v.maxListenMs,
      keepAudio: !!v.keepAudio,
      paused: this.paused,
      muted: this.muted,
      listening_until: this.listeningUntil || null,
      last_heard: this.lastHeard,
      last_error: this.lastError,
      stats: { ...this.stats },
    };
  }

  setMicGranted(granted) {
    this.micGranted = !!granted;
    audit.log({ event: granted ? "microphone_granted" : "microphone_revoked", detail: { by: "user" } });
    if (this.micGranted && this.getConfig().voice?.enabled && !this.paused && !this.muted) this._set("standby", "microphone");
    else this._set(this.micGranted ? "standby" : "permission_required", "microphone");
  }

  setPaused(paused) {
    this.paused = !!paused;
    if (this.paused) this.listeningUntil = 0;
    audit.log({ event: this.paused ? "voice_paused" : "voice_resumed" });
    this._set(this.paused ? "paused" : "standby", "user");
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.muted) this.listeningUntil = 0;
    audit.log({ event: this.muted ? "microphone_muted" : "microphone_unmuted" });
    this._set(this.muted ? "muted" : "standby", "user");
  }

  /** Called by the emergency stop so the session returns to a known state. */
  reset(reason = "reset") {
    this.listeningUntil = 0;
    this._set(this.paused ? "paused" : this.muted ? "muted" : "standby", reason);
  }

  _blocked() {
    const cfg = this.getConfig();
    const v = cfg.voice || {};
    if (!v.enabled) return { blocked: true, reason: "voice_disabled", detail: "Voice control is switched off in Settings." };
    if (!this.micGranted) return { blocked: true, reason: "microphone_not_granted", detail: "The microphone permission screen has not been accepted yet." };
    if (this.muted) return { blocked: true, reason: "muted", detail: "The microphone is muted." };
    if (this.paused) return { blocked: true, reason: "paused", detail: "Listening is paused." };
    return { blocked: false };
  }

  /**
   * One captured utterance. The caller (the window or a paired phone) does the
   * voice-activity detection and sends only the speech it heard.
   *
   * Returns one of:
   *   { action: "ignored" }            nothing matched (standby, no wake phrase)
   *   { action: "woke" }               wake phrase heard; now listening
   *   { action: "stopped" }            a stop phrase — handled with no model
   *   { action: "command", plan, job } a command was planned
   */
  async handleUtterance(wav, { durationMs = 0, device, source = "window" } = {}) {
    const cfg = this.getConfig();
    const v = cfg.voice || {};
    if (!stt.isWav(wav)) throw Object.assign(new Error("Expected a WAV recording."), { status: 400, code: "not_a_recording" });
    this.stats.utterances++;

    const blocked = this._blocked();
    // A stop phrase is honoured even while paused: it can only ever stop things.
    if (blocked.blocked && !(this.paused && !this.muted)) {
      return { action: "ignored", reason: blocked.reason, detail: blocked.detail };
    }

    let heard;
    try {
      heard = await stt.transcribe(wav, { cfg, language: v.language || "he" });
      this.lastError = null;
    } catch (e) {
      this.lastError = { message: e.message, code: e.code || null, install: e.install || null, at: Date.now() };
      this._set(this.state === "listening" ? "listening" : "standby", "stt_error");
      throw e;
    }

    const text = heard.text;
    this.lastHeard = { text, at: Date.now(), engine: heard.engine, source };
    const quiet = inQuietHours(v.quietHours);

    // 1. Stop phrases, first and without any model.
    const stopPhrase = matchAny(text, v.stopPhrases || []);
    if (stopPhrase) {
      this.stats.stops++;
      this.listeningUntil = 0;
      this._set(this.paused ? "paused" : "standby", "stop_phrase");
      audit.log({ event: "voice_stop_phrase", device: device?.name, detail: { phrase: stopPhrase, source } });
      this._remember({ kind: "stop", text, phrase: stopPhrase });
      let stopped = null;
      try {
        stopped = this.onStop ? this.onStop(`voice:${stopPhrase}`) : null;
      } catch {
        stopped = null;
      }
      this.emit("event", { type: "voice", event: "stopped", phrase: stopPhrase, text });
      return { action: "stopped", phrase: stopPhrase, text, stopped, model_used: false };
    }

    if (blocked.blocked) return { action: "ignored", reason: blocked.reason, detail: blocked.detail, text };

    const listening = this.listeningUntil > Date.now();

    // 2. Standby: only a wake phrase matters.
    if (!listening) {
      const phrase = matchAny(text, v.wakePhrases || []);
      if (!phrase) {
        this._set("standby", "not_for_jarvis");
        this._remember({ kind: "ignored", text });
        return { action: "ignored", reason: "no_wake_phrase", text };
      }
      // False-wake protection: a real wake utterance is short, long enough to
      // be speech, and not a repeat inside the cool-down window.
      const tooLong = words(text).length > MAX_WAKE_WORDS + words(phrase).length;
      const tooShort = durationMs && durationMs < MIN_WAKE_MS;
      const tooSoon = Date.now() - this.lastWakeAt < WAKE_COOLDOWN_MS;
      if (tooLong || tooShort || tooSoon) {
        this._set("standby", "false_wake");
        this.stats.falseWakes++;
        this._remember({ kind: "false_wake", text, why: tooLong ? "too_long" : tooShort ? "too_short" : "cooldown" });
        return { action: "ignored", reason: "false_wake_protection", detail: tooLong ? "Heard the wake phrase inside a longer sentence." : tooShort ? "The sound was too short to be speech." : "Woke a moment ago already.", text };
      }
      if (quiet) {
        this._remember({ kind: "quiet_hours", text });
        audit.log({ event: "voice_wake_suppressed", detail: { reason: "quiet_hours" } });
        return { action: "ignored", reason: "quiet_hours", detail: `Quiet hours are active (${v.quietHours.start}–${v.quietHours.end}).`, text };
      }

      this.lastWakeAt = Date.now();
      this.stats.wakes++;
      this.listeningUntil = Date.now() + (v.maxListenMs || 15000);
      this._set("listening", "wake");
      audit.log({ event: "voice_wake", device: device?.name, detail: { phrase, source } });
      this._remember({ kind: "wake", text, phrase });
      this.emit("event", { type: "voice", event: "woke", phrase, until: this.listeningUntil });

      // "תתעורר פתח פנקס רשימות" — the command rode along with the wake phrase.
      const rest = stripPhrase(text, phrase);
      if (rest && words(rest).length >= 1) return this._runCommand(rest, { device, source, viaWake: true });
      return { action: "woke", phrase, listening_until: this.listeningUntil, text };
    }

    // 3. Listening: this utterance is the command.
    if (!normalize(text)) {
      this._remember({ kind: "empty" });
      return { action: "ignored", reason: "nothing_heard", text: "" };
    }
    return this._runCommand(text, { device, source });
  }

  async _runCommand(text, { device, source, viaWake = false } = {}) {
    this.stats.commands++;
    this.listeningUntil = 0;
    this._set("thinking", "command");
    audit.log({ event: "voice_command", device: device?.name, detail: { source, via_wake: viaWake, chars: text.length } });
    this._remember({ kind: "command", text });
    try {
      const out = await this.onCommand(text, { device, source });
      this._set("speaking", "reply");
      this.emit("event", { type: "voice", event: "command", text, plan_id: out?.plan?.plan_id ?? null });
      return { action: "command", text, ...out };
    } catch (e) {
      this._set("standby", "command_failed");
      throw e;
    }
  }

  /** The window tells us it finished speaking the reply. */
  doneSpeaking() {
    if (this.state === "speaking" || this.state === "thinking") this.reset("spoke");
  }
}

module.exports = { VoiceSession, inQuietHours, hhmmToMinutes, STATES };
