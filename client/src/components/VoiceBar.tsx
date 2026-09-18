import { useEffect, useState } from "react";

import { CommandBar } from "./CommandBar";
import { InstallSteps } from "./InstallSteps";
import { MicPermission } from "./MicPermission";
import { useJarvis } from "../state/jarvisStore";
import type { VoiceState } from "../types";

const LABEL: Record<VoiceState, string> = {
  unavailable: "VOICE UNAVAILABLE",
  permission_required: "MICROPHONE NEEDED",
  off: "MICROPHONE OFF",
  standby: "STANDBY",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  paused: "PAUSED",
  muted: "MUTED",
  quiet_hours: "QUIET HOURS",
};

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/**
 * The primary way to use JARVIS. Voice is the input; the keyboard is a
 * deliberate fallback that stays out of the way until it is asked for.
 */
export function VoiceBar() {
  const voice = useJarvis((s) => s.voice);
  const listening = useJarvis((s) => s.listening);
  const level = useJarvis((s) => s.level);
  const micError = useJarvis((s) => s.micError);
  const micInstall = useJarvis((s) => s.micInstall);
  const micBlocked = useJarvis((s) => s.micBlocked);
  const keyboard = useJarvis((s) => s.keyboard);
  const setKeyboard = useJarvis((s) => s.setKeyboard);
  const connection = useJarvis((s) => s.connection);
  const creds = useJarvis((s) => s.creds);
  const emergency = useJarvis((s) => s.status?.emergency ?? false);
  const stopListening = useJarvis((s) => s.stopListening);
  const setVoicePaused = useJarvis((s) => s.setVoicePaused);
  const setVoiceMuted = useJarvis((s) => s.setVoiceMuted);
  const emergencyStop = useJarvis((s) => s.emergencyStop);
  const heard = useJarvis((s) => s.heard);
  const micSilent = useJarvis((s) => s.micSilent);
  const transcribing = useJarvis((s) => s.transcribing);
  const slow = useJarvis((s) => s.slow);
  const skipped = useJarvis((s) => s.skipped);
  const setVoiceMode = useJarvis((s) => s.setVoiceMode);
  const mode = voice?.engine.speed?.mode ?? "fast";
  const micDevices = useJarvis((s) => s.micDevices);
  const micDeviceId = useJarvis((s) => s.micDeviceId);
  const setMicDevice = useJarvis((s) => s.setMicDevice);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  // The "heard" line is only useful while it is recent, so a tick retires it
  // instead of leaving a stale transcript on screen.
  useEffect(() => {
    if (!heard && !transcribing) return;
    const t = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(t); };
  }, [heard, transcribing]);

  // The browser stops delivering audio when the tab is frozen; reflect that
  // rather than showing a listening indicator that is no longer true.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && useJarvis.getState().listening && !("jarvisDesktop" in window)) void useJarvis.getState().stopListening(false);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  const state: VoiceState = emergency ? "off" : micBlocked ? "unavailable" : !listening ? (voice?.state === "unavailable" ? "unavailable" : "off") : voice?.state ?? "standby";
  const engine = voice?.engine;
  // The small models understand Hebrew on paper and get the words wrong in
  // practice, which reads as "JARVIS ignores me" rather than as a model choice.
  const weakModel = /ggml-(small|base|tiny)/i.test(engine?.model ?? "");
  const wake = voice?.wakePhrases ?? [];
  const stops = voice?.stopPhrases ?? [];
  const online = connection === "online";

  const hint = emergency
    ? "Emergency stop is active. Clear it on the computer before JARVIS can listen again."
    : micBlocked
      ? micBlocked.reason
      : engine && !engine.available
        ? "No local speech engine is installed, so speech cannot be turned into text on this computer."
        : !listening
          ? "The microphone is closed. Nothing is being recorded."
          : state === "quiet_hours"
            ? `Quiet hours are active (${voice?.quietHours.start ?? ""}–${voice?.quietHours.end ?? ""}). JARVIS hears the wake phrase but will not act on it.`
            : state === "paused"
              ? "Paused. Audio is still not being sent — resume to talk again."
              : state === "muted"
                ? "Muted. JARVIS will not listen or speak."
                : state === "listening"
                  ? `Speak your command. Say ${stops.map((w) => `“${w}”`).join(" or ")} to stop everything.`
                  : `Say ${wake.map((w) => `“${w}”`).join(" or ") || "your wake phrase"}.`;

  const act = (fn: () => Promise<unknown>) => () => {
    setBusy(true);
    void fn().finally(() => {
      setBusy(false);
    });
  };

  return (
    <section className="voice" aria-label="Voice control">
      <div className="voice-main">
        <button
          type="button"
          className="mic-orb"
          data-state={state}
          data-live={listening ? "on" : "off"}
          aria-pressed={listening}
          aria-label={listening ? `Microphone is on — ${LABEL[state].toLowerCase()}. Turn the microphone off.` : "The microphone is off. Turn it on."}
          onClick={() => {
            if (listening) void stopListening();
            else setAsk(true);
          }}
          disabled={!online || emergency || !!micBlocked}
        >
          <span className="mic-level" style={{ transform: `scale(${String(1 + Math.min(0.55, level * 0.55))})` }} aria-hidden="true" />
          <MicIcon off={!listening} />
        </button>

        <div className="voice-copy">
          <strong className="voice-state" role="status" aria-live="polite">
            {LABEL[state]}
            {listening && <span className="mic-dot" aria-hidden="true" />}
          </strong>
          <p>{hint}</p>
          {transcribing && (
            <p className="voice-working" role="status">
              Working out what you said… {Math.max(0, Math.round((now - transcribing.since) / 1000))}s
              {skipped > 0 && ` · ${String(skipped)} skipped while thinking`}
            </p>
          )}
          {listening && heard && now - heard.at < 20000 && (state === "standby" || state === "quiet_hours") && (
            <p className="voice-heard">
              {heard.text
                ? <>Heard <q>{heard.text}</q> — that is not the wake phrase.</>
                : <>Something was heard, but no words came back from the speech engine. Speak a little closer, or check that Windows is using the microphone you are speaking into.</>}
              {heard.text && weakModel && (
                <>
                  {" "}
                  <span className="voice-fix">This computer is using {engine?.model}, which mishears Hebrew. Run <code>npm run voice</code> and take the turbo model (free, 1.6 GB) — that is usually the whole problem.</span>
                </>
              )}
            </p>
          )}
        </div>

        <div className="voice-actions">
          {!listening ? (
            <button type="button" className="btn btn-primary" onClick={() => { setAsk(true); }} disabled={!online || emergency || !!micBlocked}>
              Enable microphone
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={act(() => setVoicePaused(!(voice?.paused ?? false)))} disabled={busy || !online}>
                {voice?.paused ? "Resume microphone" : "Pause microphone"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={act(() => setVoiceMuted(!(voice?.muted ?? false)))} disabled={busy || !online}>
                {voice?.muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={act(() => stopListening())} disabled={busy}>
                Microphone off
              </button>
            </>
          )}
          <button type="button" className="btn btn-danger" onClick={act(() => emergencyStop())} disabled={busy || !online} title="Stop every running action immediately">
            Emergency stop
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={mode === "fast"}
            title={mode === "fast" ? "Fast: the quickest model installed, one pass" : "Accurate: the model you chose, full search"}
            onClick={act(() => setVoiceMode(mode === "fast" ? "accurate" : "fast"))}
            disabled={busy || !online || !(creds?.role === "owner")}
          >
            {mode === "fast" ? "Fast mode" : "Accurate mode"}
          </button>
          <button type="button" className="btn btn-ghost" aria-pressed={keyboard} onClick={() => { setKeyboard(!keyboard); }}>
            {keyboard ? "Hide keyboard" : "Use keyboard instead"}
          </button>
        </div>
      </div>

      {micBlocked && (
        <div className="banner banner-warn" role="note">
          <strong>This page cannot open a microphone.</strong>
          <p>{micBlocked.reason}</p>
          {micBlocked.fix && <p>{micBlocked.fix}</p>}
        </div>
      )}

      {engine && !engine.available && engine.install && (
        <div className="banner banner-warn">
          <strong>Speech to text is unavailable: {engine.reason}</strong>
          <InstallSteps install={engine.install} />
        </div>
      )}

      {/* Not hidden while the next utterance is in flight: on a machine this
          slow there is almost always one in flight, and the warning would
          flicker in and out of existence exactly when it is most needed. */}
      {engine?.speed?.fallback && (
        <div className="banner" role="note">
          <strong>Switched to {engine.speed.fallback.to} to keep up.</strong>
          <p>
            {engine.speed.fallback.from} was taking about {String(Math.round(engine.speed.fallback.ms / 100) / 10)} seconds a sentence on this
            computer, which is too long to talk to. {engine.speed.fallback.to} is already installed here and answers faster, with a little
            less accuracy. Nothing was downloaded or deleted; to go back, delete the smaller file from the speech folder.
          </p>
        </div>
      )}

      {slow && !engine?.speed?.fallback && (
        <div className="banner banner-warn" role="note">
          <strong>This computer needs {String(Math.round(slow.ms / 1000))} seconds to understand one sentence.</strong>
          <p>
            Nothing is broken — {slow.model ?? "the speech model"} is simply heavier than this processor can turn around quickly, and
            everything said while it is thinking is skipped. A smaller model answers in about a second and is a little less accurate:
            run <code>npm run voice</code> and choose <code>small</code>. Speaking one short sentence at a time also helps.
          </p>
        </div>
      )}

      {micSilent && (
        <div className="banner banner-warn" role="alert">
          <strong>The microphone is open, but completely silent.</strong>
          <p>
            Nothing at all has been heard for the last few seconds on{" "}
            <q>{micSilent.device || "the input Windows chose"}</q>. That is a device problem, not a wake-phrase one: the input is muted, unplugged, or
            it is not the microphone you are speaking into. Pick another one here, or set the right default in Windows sound settings.
          </p>
          {micDevices.length > 1 && (
            <label className="mic-pick">
              Microphone
              <select
                value={micDeviceId ?? ""}
                onChange={(e) => {
                  const id = e.target.value;
                  void setMicDevice(id || null);
                }}
              >
                <option value="">Windows default</option>
                {micDevices.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {micError && (
        <div className="banner banner-warn" role="alert">
          <strong>{micError}</strong>
          {micInstall && <InstallSteps install={micInstall} />}
        </div>
      )}

      {keyboard && <CommandBar />}
      {ask && <MicPermission onClose={() => { setAsk(false); }} />}
    </section>
  );
}
