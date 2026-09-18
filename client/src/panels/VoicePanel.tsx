import { useEffect, useState } from "react";

import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { InstallSteps } from "../components/InstallSteps";
import { describeError } from "../lib/protocol";
import { useAction } from "../lib/useAction";
import { useJarvis } from "../state/jarvisStore";
import type { VoiceHistoryEntry } from "../types";

const KIND: Record<VoiceHistoryEntry["kind"], string> = {
  wake: "woke",
  command: "command",
  stop: "stop phrase",
  ignored: "not for JARVIS",
  false_wake: "false wake, ignored",
  quiet_hours: "quiet hours, ignored",
  empty: "nothing heard",
};

export function VoicePanel() {
  const setPanel = useJarvis((s) => s.setPanel);
  const voice = useJarvis((s) => s.voice);
  const refreshVoice = useJarvis((s) => s.refreshVoice);
  const [history, setHistory] = useState<VoiceHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [recheck, recheckState] = useAction(async () => {
    await refreshVoice(true);
  });

  useEffect(() => {
    void api
      .voiceHistory(50)
      .then((r) => { setHistory(r.history); })
      .catch((err: unknown) => { setError(describeError(err)); });
  }, [voice]);

  const engine = voice?.engine;

  const wakeModel = useJarvis((st) => st.wakeModel);
  const wakeTeaching = useJarvis((st) => st.wakeTeaching);
  const teachWakeWord = useJarvis((st) => st.teachWakeWord);
  const forgetWakeWord = useJarvis((st) => st.forgetWakeWord);
  const micBlocked = useJarvis((st) => st.micBlocked);

  return (
    <Dialog title="Voice" onClose={() => { setPanel(null); }} wide>
      <div className="grid-2">
        <section>
          <h3>Speech to text (on this computer)</h3>
          <dl className="kv">
            <dt>Engine</dt>
            <dd>{engine?.available ? engine.name ?? "?" : "none installed"}</dd>
            <dt>Model</dt>
            <dd>{engine?.model ?? "—"}</dd>
            <dt>Model in memory</dt>
            <dd>
              {engine?.speed?.server?.running
                ? `yes — ${engine.speed.server.model ?? "loaded"}, so each sentence skips loading it again`
                : "no — the model is read from disk for every sentence, which is most of the wait"}
            </dd>
            <dt>Speed</dt>
            <dd>{engine?.speed?.mode === "accurate" ? "Accurate — full search, the model you chose" : "Fast — one pass, the quickest model installed"}</dd>
            <dt>Hebrew</dt>
            <dd>{engine?.hebrew ? "supported by this model" : "not available with what is installed"}</dd>
            <dt>State</dt>
            <dd>{voice?.state ?? "—"}</dd>
            <dt>Wake phrases</dt>
            <dd>{voice?.wakePhrases.join(", ") || "—"}</dd>
            <dt>Stop phrases</dt>
            <dd>{voice?.stopPhrases.join(", ") || "—"}</dd>
            <dt>Quiet hours</dt>
            <dd>{voice?.quietHours.enabled ? `${voice.quietHours.start ?? ""}–${voice.quietHours.end ?? ""}${voice.quietHours.active ? " (active now)" : ""}` : "off"}</dd>
            <dt>Keep recordings</dt>
            <dd>{voice?.keepAudio ? "ON — recordings are kept on this computer" : "off — each temporary WAV is deleted right after it is transcribed"}</dd>
          </dl>
          <h3>Instant wake word (no transcription)</h3>
          <p className="muted small">
            Taught here, the wake phrase is recognised in this window in about a millisecond, by comparing the sound to recordings of you
            saying it. The speech engine is then only used for what you actually ask, which is where its accuracy matters and its seconds
            are affordable. The recordings never leave this computer and are not audio: what is kept is a few hundred numbers describing
            the shape of the sound.
          </p>
          {wakeTeaching ? (
            <div className="banner">
              <strong>Say the wake phrase now — recording {wakeTeaching.step} of {wakeTeaching.of}.</strong>
              <p>Say it the way you normally would, then pause.</p>
            </div>
          ) : wakeModel ? (
            <div className="row gap">
              <span className="muted small">Taught {new Date(wakeModel.at).toLocaleDateString()} · {wakeModel.templates.length} recordings</span>
              <button type="button" className="btn btn-ghost" onClick={() => { void teachWakeWord(); }}>Teach it again</button>
              <button type="button" className="btn btn-ghost" onClick={() => { forgetWakeWord(); }}>Forget it</button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => { void teachWakeWord(); }} disabled={!!micBlocked}>
              Teach JARVIS your wake word
            </button>
          )}

          {engine && !engine.available && (
            <div className="banner banner-warn">
              <strong>{engine.reason}</strong>
              {engine.install && <InstallSteps install={engine.install} />}
            </div>
          )}
          {engine?.available && !engine.hebrew && (
            <div className="banner banner-warn">
              <strong>{engine.reason ?? "The installed model cannot do Hebrew."}</strong>
              {engine.install && <InstallSteps install={engine.install} title="Install a multilingual model" />}
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => void recheck()} disabled={recheckState.phase === "loading"}>
            {recheckState.phase === "loading" ? "Checking…" : "Check again"}
          </button>
          {engine && (
            <details>
              <summary>Where JARVIS looked</summary>
              <ul className="list">
                {engine.checked.whisperBinaries.map((b) => (
                  <li key={b}>{b}</li>
                ))}
                {engine.checked.whisperModels.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section>
          <h3>What JARVIS heard</h3>
          <p className="help">Transcripts only — no audio is stored. Erase these from Settings → Delete local data.</p>
          <dl className="kv">
            <dt>Wakes</dt>
            <dd>{voice?.stats.wakes ?? 0}</dd>
            <dt>False wakes ignored</dt>
            <dd>{voice?.stats.falseWakes ?? 0}</dd>
            <dt>Commands</dt>
            <dd>{voice?.stats.commands ?? 0}</dd>
            <dt>Voice stops</dt>
            <dd>{voice?.stats.stops ?? 0}</dd>
            <dt>Utterances processed</dt>
            <dd>{voice?.stats.utterances ?? 0}</dd>
          </dl>
          <ul className="list">
            {history.length === 0 && <li className="help">Nothing yet.</li>}
            {history.map((h, i) => (
              <li key={i}>
                <span className="log-meta">{new Date(h.at).toLocaleTimeString()} · {KIND[h.kind]}</span>
                <div>{h.text ?? "—"}</div>
              </li>
            ))}
          </ul>
          {voice?.last_error && (
            <div className="banner banner-warn">
              <strong>Last error: {voice.last_error.message}</strong>
              {voice.last_error.install && <InstallSteps install={voice.last_error.install} />}
            </div>
          )}
          {error && <p className="error-text">{error}</p>}
        </section>
      </div>
    </Dialog>
  );
}
