import { useState } from "react";

import { Dialog } from "./Dialog";
import { InstallSteps } from "./InstallSteps";
import { micSupport } from "../lib/mic";
import { useJarvis } from "../state/jarvisStore";

/**
 * Shown before the microphone is ever opened. It states exactly what will be
 * recorded, where it goes, and what is kept — and it is the only place that
 * can start listening.
 */
export function MicPermission({ onClose }: { onClose: () => void }) {
  const voice = useJarvis((s) => s.voice);
  const settings = useJarvis((s) => s.settings);
  const startListening = useJarvis((s) => s.startListening);
  const micError = useJarvis((s) => s.micError);
  const [asking, setAsking] = useState(false);
  const support = micSupport();
  const engine = voice?.engine;
  const keepAudio = voice?.keepAudio ?? settings?.voice.keepAudio ?? false;
  const wake = voice?.wakePhrases ?? settings?.voice.wakePhrases ?? [];
  const stop = voice?.stopPhrases ?? settings?.voice.stopPhrases ?? [];

  const allow = async () => {
    setAsking(true);
    try {
      await startListening();
      if (useJarvis.getState().listening) onClose();
    } finally {
      setAsking(false);
    }
  };

  return (
    <Dialog title="Microphone permission" onClose={onClose} wide>
      <p>
        JARVIS listens for the wake phrase {wake.map((w) => `“${w}”`).join(" or ") || "you configure"} and does nothing else with what it hears.
      </p>
      <ul className="list">
        <li>
          <strong>The audio never leaves this computer.</strong> The recording is sent to the JARVIS agent running on this machine, over your own network, and is transcribed by a speech engine installed on the same machine. There is no cloud service, no account and no key involved.
        </li>
        <li>
          <strong>Raw audio is not saved.</strong> The agent writes one temporary WAV file for the speech engine to read and deletes it immediately afterwards. {keepAudio ? "“Keep audio” is currently ON in Settings, so recordings are being kept until you turn it off." : "“Keep audio” is off, which is the default."}
        </li>
        <li>
          <strong>Only text is remembered.</strong> What you said is kept as a transcript in the voice history and the activity log, and you can erase both from Settings → Delete local data.
        </li>
        <li>
          <strong>You can stop it at any time.</strong> Pause the microphone, mute JARVIS, say {stop.map((w) => `“${w}”`).join(" / ") || "your stop phrase"}, or press Emergency Stop.
        </li>
      </ul>

      {!support.supported && (
        <div className="banner banner-warn" role="alert">
          <strong>The microphone cannot be opened on this page.</strong>
          <p>{support.reason}</p>
          {support.fix && <p>{support.fix}</p>}
        </div>
      )}

      {engine && !engine.available && (
        <div className="banner banner-warn">
          <strong>No local speech engine is installed, so nothing can be transcribed yet.</strong>
          <p>{engine.reason}</p>
          {engine.install && <InstallSteps install={engine.install} />}
        </div>
      )}

      {engine?.available && !engine.hebrew && (settings?.voice.language ?? "he").startsWith("he") && (
        <div className="banner banner-warn">
          <strong>Hebrew speech recognition is not available with the installed model.</strong>
          <p>{engine.reason ?? "The installed model is English-only."}</p>
          {engine.install && <InstallSteps install={engine.install} title="Install a multilingual model" />}
        </div>
      )}

      {micError && (
        <p className="error-text" role="alert">
          {micError}
        </p>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Not now
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void allow()} disabled={asking || !support.supported}>
          {asking ? "Waiting for the browser…" : "Allow microphone and start listening"}
        </button>
      </div>
      <p className="help">The browser will ask for its own permission next. JARVIS cannot open the microphone without it.</p>
    </Dialog>
  );
}
