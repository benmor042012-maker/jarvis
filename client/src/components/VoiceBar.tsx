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
  const emergency = useJarvis((s) => s.status?.emergency ?? false);
  const stopListening = useJarvis((s) => s.stopListening);
  const setVoicePaused = useJarvis((s) => s.setVoicePaused);
  const setVoiceMuted = useJarvis((s) => s.setVoiceMuted);
  const emergencyStop = useJarvis((s) => s.emergencyStop);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);

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
